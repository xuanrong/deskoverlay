//! USN/$MFT 式全盘索引（方案 C）——用 `FSCTL_ENUM_USN_DATA` 直接读 NTFS 卷的 MFT，
//! 秒级建索引（毫秒定位、无需逐个目录遍历），路径由 (file ref, parent ref) 自底向上重建。
//!
//! 前置要求：以管理员/备份权限运行（打开 `\\.\C:` 原始卷句柄）。任一卷读失败（多半未提权
//! 或非 NTFS）即整体返回 None，由调用方回退到目录遍历索引（方案 A），保证无权限时仍可用。

use std::collections::HashMap;
use std::ffi::c_void;
use std::mem::size_of;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_MODE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::IO::DeviceIoControl;
use windows::Win32::System::Ioctl::{FSCTL_ENUM_USN_DATA, MFT_ENUM_DATA_V0};

use crate::file_index::{Hit, SKIP};

const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;

/// 逐卷用 USN 枚举建全盘索引；任一卷失败即回退（返回 None）。
pub fn try_build() -> Option<Vec<Hit>> {
    let mut out = Vec::new();
    for root in crate::file_index::fixed_drives() {
        let hits = enumerate_volume(&root)?;
        out.extend(hits);
    }
    if out.is_empty() { None } else { Some(out) }
}

/// 打开某卷的原始句柄（需管理员/备份权限）。
fn open_volume(root: &str) -> Option<HANDLE> {
    let vol = format!("\\\\.\\{}\\", root.trim_end_matches('\\')); // \\.\C:\
    let wide: Vec<u16> = vol.encode_utf16().chain(std::iter::once(0)).collect();
    let share = FILE_SHARE_MODE(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0);
    let h = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            GENERIC_READ.0,
            share,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    }
    .ok()?;
    if h.is_invalid() { None } else { Some(h) }
}

#[inline]
fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
#[inline]
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
#[inline]
fn u64_at(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5], b[o + 6], b[o + 7]])
}

/// 枚举单个 NTFS 卷的 MFT 记录并重建完整路径。
fn enumerate_volume(root: &str) -> Option<Vec<Hit>> {
    let handle = open_volume(root)?;
    let mut name: HashMap<u64, (String, bool)> = HashMap::new();
    let mut children: HashMap<u64, Vec<u64>> = HashMap::new();

    let mut inp = MFT_ENUM_DATA_V0 { StartFileReferenceNumber: 0, LowUsn: 0, HighUsn: 0 };
    let mut buf = [0u8; 1 << 20]; // 1MB 缓冲，减少 ioctl 往返
    let mut any = false;

    loop {
        let mut ret: u32 = 0;
        let rc = unsafe {
            DeviceIoControl(
                handle,
                FSCTL_ENUM_USN_DATA,
                Some(&inp as *const _ as *const c_void),
                size_of::<MFT_ENUM_DATA_V0>() as u32,
                Some(buf.as_mut_ptr() as *mut c_void),
                buf.len() as u32,
                Some(&mut ret),
                None,
            )
        };
        if rc.is_err() || ret == 0 {
            break;
        }
        let mut off = 0usize;
        let mut last = 0u64;
        let mut parsed = 0usize;
        let limit = ret as usize;
        while off + 4 <= limit {
            let rec_len = u32_at(&buf, off) as usize;
            if rec_len < 60 || off + rec_len > limit {
                break;
            }
            let fre = u64_at(&buf, off + 8);
            let pfre = u64_at(&buf, off + 16);
            let attrs = u32_at(&buf, off + 52);
            let nl = u16_at(&buf, off + 56) as usize;
            let no = u16_at(&buf, off + 58) as usize;
            let start = off + no;
            if start + nl > limit {
                break;
            }
            // 跳过 NTFS 系统元文件（MFT 前 24 个槽位）
            if fre >= 24 && nl > 0 {
                let units = nl / 2;
                let p = unsafe { buf.as_ptr().add(start) } as *const u16;
                let mut wide = Vec::with_capacity(units);
                for i in 0..units {
                    wide.push(unsafe { core::ptr::read_unaligned(p.add(i)) });
                }
                let nm = String::from_utf16_lossy(&wide);
                name.insert(fre, (nm, attrs & FILE_ATTRIBUTE_DIRECTORY != 0));
                children.entry(pfre).or_default().push(fre);
                any = true;
            }
            last = fre;
            parsed += 1;
            off += rec_len;
        }
        if parsed == 0 {
            break;
        }
        inp.StartFileReferenceNumber = last.wrapping_add(1);
    }
    unsafe {
        let _ = CloseHandle(handle);
    }
    if !any {
        return None;
    }

    // 自根重建路径：根目录引用号通常为 5。
    let drive = format!("{}\\", root.trim_end_matches('\\'));
    let mut result: Vec<Hit> = Vec::new();
    let mut stack: Vec<(u64, String)> = Vec::new();
    if let Some(tops) = children.get(&5) {
        for &c in tops {
            stack.push((c, drive.clone()));
        }
    }
    while let Some((refno, dir)) = stack.pop() {
        let Some((nm, isdir)) = name.get(&refno) else { continue };
        if SKIP.contains(&nm.to_ascii_lowercase().as_str()) {
            continue; // 跳过该目录及其整棵子树
        }
        result.push(Hit {
            path: if dir.is_empty() { nm.clone() } else { format!("{dir}\\{nm}") },
            is_dir: *isdir,
        });
        if *isdir {
            if let Some(kids) = children.get(&refno) {
                let base = if dir.is_empty() { nm.clone() } else { format!("{dir}\\{nm}") };
                for &k in kids {
                    stack.push((k, base.clone()));
                }
            }
        }
    }
    Some(result)
}