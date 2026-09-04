// 文件类型分类与图标 — 供「文件中心」与「快捷访问」复用（按扩展名归类）。
import { ICON_FOLDER, ICON_IMAGE, ICON_DOC, ICON_CODE, ICON_ARCHIVE, ICON_VIDEO, ICON_MUSIC, ICON_PAPERCLIP } from "./icons.js";

export const FILE_CATEGORIES = {
  图片: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico"],
  文档: ["doc", "docx", "pdf", "txt", "md", "xlsx", "xls", "pptx", "ppt", "csv"],
  代码: ["js", "ts", "rs", "py", "go", "java", "cpp", "c", "h", "html", "css", "json", "xml", "sh"],
  压缩: ["zip", "rar", "7z", "tar", "gz", "bz2"],
  视频: ["mp4", "avi", "mkv", "mov", "wmv", "flv", "webm"],
  音频: ["mp3", "wav", "flac", "aac", "ogg", "m4a"],
};

export const FILE_ICONS = {
  文件夹: ICON_FOLDER, 图片: ICON_IMAGE, 文档: ICON_DOC, 代码: ICON_CODE,
  压缩: ICON_ARCHIVE, 视频: ICON_VIDEO, 音频: ICON_MUSIC, 其他: ICON_PAPERCLIP,
};