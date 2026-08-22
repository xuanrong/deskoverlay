//! 嵌入式 Wasm 插件运行时：加载外部插件的 Rust→wasm 后端，宿主内沙箱执行（轻量解释器 wasmi）。
//!
//! 与后端模板约定（wasm32-unknown-unknown，自含，无 WASI）：
//!   - 导出 `memory`
//!   - 导出 `alloc(size: i32) -> i32`：bump 分配器，返回线性内存偏移
//!   - 导出 `run(in_ptr: i32, in_len: i32) -> i32`：处理输入，返回结果长度
//!   - 导出 `get_result_ptr() -> i32`：返回结果所在偏移
//!   - 导入 `env.host_log(ptr, len)`：宿主日志能力（示例能力注入）

use wasmi::{Caller, Config, Engine, Linker, Module, Store, TypedFunc};

/// 运行一个 wasm 后端：注入能力 → 实例化 → 传输入 → 拿结果字符串。
pub fn run_backend(wasm: &[u8], input: &str) -> Result<String, String> {
    let engine = Engine::new(&Config::default());

    let mut linker = Linker::<()>::new(&engine);
    // 示例能力注入：host_log（把插件日志打到宿主 stderr）
    linker
        .func_wrap(
            "env",
            "host_log",
            |caller: Caller<'_, ()>, ptr: i32, len: i32| -> Result<(), wasmi::core::Trap> {
                if let Some(mem) = caller.get_export("memory").and_then(|e| e.into_memory()) {
                    let data = mem.data(&caller);
                    let s = ptr.max(0) as usize;
                    let e = (s + len.max(0) as usize).min(data.len());
                    if s <= e {
                        eprintln!("[wasm-plugin] {}", String::from_utf8_lossy(&data[s..e]));
                    }
                }
                Ok(())
            },
        )
        .map_err(|e| e.to_string())?;

    let module = Module::new(&engine, wasm).map_err(|e| format!("wasm 模块无效：{e}"))?;
    let mut store = Store::new(&engine, ());
    let instance_pre = linker
        .instantiate(&mut store, &module)
        .map_err(|e| e.to_string())?;
    let instance = instance_pre.start(&mut store).map_err(|e| e.to_string())?;

    let memory = instance
        .get_memory(&store, "memory")
        .ok_or_else(|| "插件缺少 memory 导出".to_string())?;
    let alloc: TypedFunc<i32, i32> = instance
        .get_typed_func(&store, "alloc")
        .map_err(|e| format!("缺少 alloc 导出：{e}"))?;
    let run: TypedFunc<(i32, i32), i32> = instance
        .get_typed_func(&store, "run")
        .map_err(|e| format!("缺少 run 导出：{e}"))?;
    let get_ptr: TypedFunc<(), i32> = instance
        .get_typed_func(&store, "get_result_ptr")
        .map_err(|e| format!("缺少 get_result_ptr 导出：{e}"))?;

    // 输入写入插件内存
    let in_bytes = input.as_bytes();
    let in_off = alloc.call(&mut store, in_bytes.len() as i32).map_err(|e| e.to_string())?;
    {
        let data = memory.data_mut(&mut store);
        let s = in_off.max(0) as usize;
        let e = (s + in_bytes.len()).min(data.len());
        data[s..e].copy_from_slice(&in_bytes[..e - s]);
    }

    // 调用处理入口
    let res_len = run
        .call(&mut store, (in_off, in_bytes.len() as i32))
        .map_err(|e| format!("插件执行失败：{e}"))?;
    let res_ptr = get_ptr.call(&mut store, ()).map_err(|e| e.to_string())?;

    // 读取结果
    let out;
    {
        let data = memory.data(&store);
        let s = res_ptr.max(0) as usize;
        let e = (s + res_len.max(0) as usize).min(data.len());
        out = String::from_utf8_lossy(&data[s..e]).into_owned();
    }
    Ok(out)
}