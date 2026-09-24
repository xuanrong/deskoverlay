// 全局护眼 P0 端到端验证（独立可执行，不依赖 Tauri 运行时）
//
// 验证目标：
//   1. kelvin_to_rgb 的色温换算符合预期（低色温蓝通道衰减）
//   2. build_ramp 满足官方 32768 偏差限制
//   3. SetDeviceGammaRamp 真实生效（回读比对，不信返回值）
//   4. GetDeviceGammaRamp → 还原 链路正确（关闭后精确回到原始值）
//
// 运行：cargo run --example eyecare_probe --features ... （见下方运行命令注释）
// 注意：会真实改变屏幕色温约 2 秒，随后自动还原。

use windows::Win32::Graphics::Gdi::{GetDC, ReleaseDC, HDC};
use windows::Win32::UI::ColorSystem::{GetDeviceGammaRamp, SetDeviceGammaRamp};

type Ramp = [u16; 768];

fn kelvin_to_rgb(kelvin: f64) -> (f64, f64, f64) {
    let t = kelvin.clamp(1000.0, 40000.0) / 100.0;
    let r = if t <= 66.0 {
        255.0
    } else {
        (329.698_727_446 * (t - 60.0).powf(-0.133_204_759_2)).clamp(0.0, 255.0)
    };
    let g = if t <= 66.0 {
        (99.470_802_586_1 * t.ln() - 161.119_568_166_1).clamp(0.0, 255.0)
    } else {
        (288.122_169_528_3 * (t - 60.0).powf(-0.075_514_849_2)).clamp(0.0, 255.0)
    };
    let b = if t >= 66.0 {
        255.0
    } else if t <= 19.0 {
        0.0
    } else {
        (138.517_731_223_1 * (t - 10.0).ln() - 305.044_792_730_7).clamp(0.0, 255.0)
    };
    (r / 255.0, g / 255.0, b / 255.0)
}

fn identity_value(i: usize) -> u16 {
    ((i as f64 / 255.0) * 65535.0).round() as u16
}

fn clamp_to_safe_deviation(i: usize, v: f64) -> u16 {
    const MAX_DEV: i32 = 32768;
    // 先量化再夹取，且边界向内对齐到 8 位网格（见 eyecare.rs 同函数注释）
    let quantized = ((v.clamp(0.0, 65535.0) as u16) & 0xFF00) as i32;
    let id = identity_value(i) as i32;
    let lo = ((id - MAX_DEV).max(0) + 255) & !255;
    let hi = ((id + MAX_DEV).min(65535)) & !255;
    quantized.clamp(lo.min(hi), hi) as u16
}

fn build_ramp(kelvin: f64, brightness: f64, contrast: f64) -> Ramp {
    let (kr, kg, kb) = kelvin_to_rgb(kelvin);
    let brightness = brightness.clamp(0.5, 1.0);
    let contrast = contrast.clamp(0.8, 1.0);
    let mut ramp = [0u16; 768];
    for ch in 0..3 {
        let gain = match ch {
            0 => kr,
            1 => kg,
            _ => kb,
        } * brightness;
        for i in 0..256usize {
            let x = i as f64 / 255.0;
            let x = 0.5 + (x - 0.5) * contrast;
            let v = (x.clamp(0.0, 1.0) * gain * 65535.0).clamp(0.0, 65535.0);
            ramp[ch * 256 + i] = clamp_to_safe_deviation(i, v);
        }
    }
    ramp
}

fn with_dc<T>(f: impl FnOnce(HDC) -> T) -> Option<T> {
    unsafe {
        let hdc = GetDC(None);
        if hdc.is_invalid() {
            return None;
        }
        let out = f(hdc);
        let _ = ReleaseDC(None, hdc);
        Some(out)
    }
}

fn get_ramp() -> Option<Ramp> {
    with_dc(|hdc| {
        let mut r = [0u16; 768];
        let ok = unsafe { GetDeviceGammaRamp(hdc, r.as_mut_ptr() as *mut core::ffi::c_void) };
        if ok.as_bool() {
            Some(r)
        } else {
            None
        }
    })
    .flatten()
}

fn set_ramp(ramp: &Ramp) -> bool {
    with_dc(|hdc| unsafe {
        SetDeviceGammaRamp(hdc, ramp.as_ptr() as *const core::ffi::c_void).as_bool()
    })
    .unwrap_or(false)
}

fn ramp_close(a: &Ramp, b: &Ramp) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| x.abs_diff(*y) <= 256)
}

fn main() {
    let mut pass = 0;
    let mut fail = 0;
    let mut check = |name: &str, ok: bool, detail: String| {
        if ok {
            pass += 1;
            println!("  [PASS] {name}  {detail}");
        } else {
            fail += 1;
            println!("  [FAIL] {name}  {detail}");
        }
    };

    println!("=== 1. 色温换算（纯函数）===");
    let (r65, g65, b65) = kelvin_to_rgb(6500.0);
    let (r27, g27, b27) = kelvin_to_rgb(2700.0);
    println!("  6500K → R={r65:.3} G={g65:.3} B={b65:.3}");
    println!("  2700K → R={r27:.3} G={g27:.3} B={b27:.3}");
    check(
        "6500K 接近白点（三通道都高）",
        r65 > 0.9 && g65 > 0.9 && b65 > 0.9,
        format!("min={:.3}", r65.min(g65).min(b65)),
    );
    check(
        "2700K 蓝通道显著衰减（暖色）",
        b27 < 0.5 && r27 > 0.9,
        format!("R={r27:.3} B={b27:.3}"),
    );
    check("色温越低蓝越少（单调性）", b27 < b65, format!("{b27:.3} < {b65:.3}"));

    println!("\n=== 2. ramp 生成满足官方 32768 偏差限制 ===");
    let target = build_ramp(3400.0, 0.8, 0.9);
    let mut max_dev = 0u32;
    let mut low_byte_nonzero = 0;
    for ch in 0..3 {
        for i in 0..256usize {
            let v = target[ch * 256 + i];
            let id = identity_value(i) as u32;
            max_dev = max_dev.max((v as i64 - id as i64).unsigned_abs() as u32);
            if v & 0x00FF != 0 {
                low_byte_nonzero += 1;
            }
        }
    }
    check("最大偏差 ≤ 32768", max_dev <= 32768, format!("max_dev={max_dev}"));
    check(
        "所有值存于 WORD 最高有效位",
        low_byte_nonzero == 0,
        format!("低字节非零项={low_byte_nonzero}"),
    );

    println!("\n=== 3. 真实读写显示器 Gamma（会短暂改变屏幕色温）===");
    let original = match get_ramp() {
        Some(r) => r,
        None => {
            println!("  [SKIP] GetDeviceGammaRamp 失败：当前环境不支持（远程桌面 / 驱动屏蔽）");
            println!("\n结果：{pass} 通过 / {fail} 失败 / 真实读写已跳过");
            return;
        }
    };
    println!("  已读取原始 ramp（前 3 项 R/G/B）：{}/{}/{}",
             original[0], original[256], original[512]);

    // 写入暖色
    let ok_write = set_ramp(&target);
    check("SetDeviceGammaRamp 调用成功", ok_write, String::new());

    // 回读比对 —— 这是唯一可信的生效判据（API 可能静默失败）
    let after = get_ramp();
    let really_applied = after.map(|a| ramp_close(&a, &target)).unwrap_or(false);
    check(
        "回读确认真正生效（防静默失败）",
        really_applied,
        match after {
            Some(a) => format!("回读 B[255]={} (目标 {})", a[512 + 255], target[512 + 255]),
            None => "回读失败".into(),
        },
    );

    println!("  >>> 屏幕此刻应为暖色（约 1.5 秒后还原）");
    std::thread::sleep(std::time::Duration::from_millis(1500));

    println!("\n=== 4. 还原链路 ===");
    let ok_restore = set_ramp(&original);
    check("还原调用成功", ok_restore, String::new());
    let restored = get_ramp();
    let exactly_back = restored.map(|r| ramp_close(&r, &original)).unwrap_or(false);
    check("精确还原到原始 ramp", exactly_back, String::new());

    println!("\n=== 5. 边界值安全性 ===");
    // 最极端参数：最低亮度 + 最低对比度 + 最低色温，仍须满足偏差限制
    let extreme = build_ramp(2000.0, 0.5, 0.8);
    let mut extreme_dev = 0u32;
    for ch in 0..3 {
        for i in 0..256usize {
            let v = extreme[ch * 256 + i];
            let id = identity_value(i) as u32;
            extreme_dev = extreme_dev.max((v as i64 - id as i64).unsigned_abs() as u32);
        }
    }
    check(
        "极端参数仍满足偏差限制（不会变全黑）",
        extreme_dev <= 32768,
        format!("max_dev={extreme_dev}"),
    );

    println!("\n结果：{pass} 通过 / {fail} 失败");
    if fail > 0 {
        std::process::exit(1);
    }
}
