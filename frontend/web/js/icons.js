// 线性 SVG 图标集（stroke currentColor / fill none / 24 viewBox）
// 统一用于导航、文件中心、系统健康、提醒、命令条等，替代 emoji。

export const ICON_HOME = `<svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8"/><path d="M5 10.5V21h14V10.5"/><path d="M10 21v-6h4v6"/></svg>`;
export const ICON_ACTIVITY = `<svg viewBox="0 0 24 24"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>`;
export const ICON_MUSIC = `<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
// 笔记列表：左侧装订环 + 内文行（列表语义）
export const ICON_NOTES = `<svg viewBox="0 0 24 24"><path d="M2 6.5h4"/><path d="M2 11h4"/><path d="M2 15.5h4"/><path d="M2 20h4"/><rect x="5.5" y="2.5" width="16" height="19" rx="2"/><path d="M10 8h7"/><path d="M10 12h7"/><path d="M10 16h4"/></svg>`;

// 文件中心分类
export const ICON_FOLDER = `<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
export const ICON_IMAGE = `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 15l-5-5-9 9"/></svg>`;
export const ICON_DOC = `<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 12h6M9 16h6"/></svg>`;
export const ICON_CODE = `<svg viewBox="0 0 24 24"><path d="M8 8l-4 4 4 4"/><path d="M16 8l4 4-4 4"/><path d="M13 5l-2 14"/></svg>`;
export const ICON_ARCHIVE = `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M9 13h6"/></svg>`;
export const ICON_VIDEO = `<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="M15.5 11l6-3v8l-6-3z"/></svg>`;
export const ICON_PAPERCLIP = `<svg viewBox="0 0 24 24"><path d="M21 12l-8 8a5 5 0 0 1-7-7l8.5-8.5a3 3 0 0 1 4 4L10 16.5a1.5 1.5 0 0 1-2-2l6-6"/></svg>`;

// 文件操作 / 通用动作
export const ICON_EXTERNAL = `<svg viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6"/></svg>`;
export const ICON_SEARCH = `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>`;
export const ICON_EDIT = `<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
export const ICON_TRASH = `<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
export const ICON_CHECK = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>`;

export const ICON_CLOSE = `<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
export const ICON_BACK = `<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>`;
export const ICON_REFRESH = `<svg viewBox="0 0 24 24"><path d="M21 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L21 10"/></svg>`;
export const ICON_ALBUM = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>`;
export const ICON_CHEV = `<svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>`;
// 「拓展展开」：四角向外的双箭头 —— 表示把卡片放大成整屏浮层。
// 语义比 ICON_CHEV（单个人字形）明确：CHEV 是「往后翻一页」，
// 这个是「铺开 / 最大化」，正好对应「点开成为浮层」。
// 只用 4 条斜线 + 4 个箭头拐角，13px 下依然清晰。
export const ICON_EXPAND = `<svg viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4l-7 7"/><path d="M10 20H4v-6"/><path d="M4 20l7-7"/></svg>`;

// 系统健康
export const ICON_GEAR = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>`;
export const ICON_CHIP = `<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M9 6V3M15 6V3M9 21v-3M15 21v-3M6 9H3M6 15H3M21 9h-3M21 15h-3"/></svg>`;
export const ICON_GLOBE = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a13 13 0 0 1 0 18a13 13 0 0 1 0-18"/></svg>`;
export const ICON_PLUG = `<svg viewBox="0 0 24 24"><path d="M9 3v6M15 3v6"/><path d="M6 9h12v4a6 6 0 0 1-12 0z"/></svg>`;

// 提醒
export const ICON_WATER = `<svg viewBox="0 0 24 24"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0C6 9.5 12 3 12 3z"/></svg>`;
export const ICON_CALENDAR = `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>`;
export const ICON_BUILDING = `<svg viewBox="0 0 24 24"><path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M16 9h4v12"/><path d="M4 21h16"/><path d="M8 8h2M8 12h2M8 16h2"/></svg>`;
export const ICON_CLOCK = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`;
export const ICON_BELL = `<svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`;
// 护眼（全局）：眼睛轮廓 + 虹膜。用于设置页与指令条
export const ICON_EYE = `<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3.2"/></svg>`;

// 音乐播放模式
export const ICON_SHUFFLE = `<svg viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20 20 4"/><path d="M21 15v6h-6"/><path d="M4 4l5 5"/></svg>`;
export const ICON_REPEAT = `<svg viewBox="0 0 24 24"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>`;
// 定位当前歌曲（准星：外圈 + 中心点 + 四向刻度）
export const ICON_LOCATE = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.6"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`;

// 音乐播放控制（统一线性风格）
export const ICON_HEART = `<svg viewBox="0 0 24 24"><path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/></svg>`;
export const ICON_PREV = `<svg viewBox="0 0 24 24"><path d="M6 4v16"/><path d="M20 5l-10 7 10 7z"/></svg>`;
export const ICON_NEXT = `<svg viewBox="0 0 24 24"><path d="M18 4v16"/><path d="M4 5l10 7-10 7z"/></svg>`;
export const ICON_PLAY = `<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>`;
export const ICON_PAUSE = `<svg viewBox="0 0 24 24"><path d="M8 4v16"/><path d="M16 4v16"/></svg>`;
export const ICON_LIST = `<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>`;
export const ICON_MORE = `<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`;
export const ICON_VOLUME = `<svg viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`;
// 静音：喇叭 + 斜杠（覆盖原声波弧线）
export const ICON_VOLUME_MUTE = `<svg viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m16 9 6 6"/><path d="m22 9-6 6"/></svg>`;
// 桌面歌词（条状浮层 + 两行歌词文本）
export const ICON_LYRICS = `<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M6.5 10h7"/><path d="M6.5 14h11"/></svg>`;

export const ICON_GRID = `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>`;

// 灵感碎片
export const ICON_IDEA = `<svg viewBox="0 0 24 24"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 1 3.6 10.8c-.7.5-1.1 1.3-1.2 2.2h-4.8c-.1-.9-.5-1.7-1.2-2.2A6 6 0 0 1 12 3z"/><path d="M12 8v2"/><path d="M12 13h.01"/></svg>`;

// 音乐下载（向下箭头入托盘）
export const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`;
// 云盘（音乐页左侧「喜欢」下方的固定入口）
export const ICON_CLOUD = `<svg viewBox="0 0 24 24"><path d="M17.5 19a4.5 4.5 0 0 0 .42-8.98 6 6 0 0 0-11.7 1.7A4 4 0 0 0 6.5 19Z"/></svg>`;
// 上传（向上箭头出托盘）：ICON_DOWNLOAD 的镜像，成对使用
export const ICON_UPLOAD = `<svg viewBox="0 0 24 24"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`;
// 基金（上升趋势折线 + 右上箭头，宿主线性 SVG 风格）
export const ICON_FUND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 4 8-8"/><path d="M15 8h6v6"/></svg>`;
// AI（四芒星火花 + 小星，线性风格）
export const ICON_AI = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2 6 6 1-6 1-2 6-2-6-6-1 6-1z"/><circle cx="18.5" cy="5.5" r="1"/></svg>`;
// 积分（圆币 + 内嵌五角星）：签到积分卡片的模块图标
export const ICON_CREDIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.4l1.55 3.15 3.45.5-2.5 2.45.6 3.45-3.1-1.63-3.1 1.63.6-3.45-2.5-2.45 3.45-.5z"/></svg>`;

// 木鱼（电子木鱼卡的**标题栏**图标，16px）。
//
// 这版是手绘的，不是描摹的 —— 用户明确要求「原来的 svg 图标挺好的 不要换」。
// 造型照真实木鱼照片提炼，三个结构特征：
//   ① 本体是横向的圆鼓（宽略大于高），不是正圆也不是钟形；
//   ② 一条敲击口贴着**底部轮廓**向右延伸 —— 画在中间会变成「笑脸」，画贴底才像木鱼；
//   ③ 敲击口左端有一个小圆孔（共鸣孔），有了它才不会被误认成「碗/贝壳」。
// 不带木槌：16px 下槌子只剩几个像素，反而把鱼身挤小。
export const ICON_MUYU = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.1 4.6c4.9 0 8.8 3.2 8.8 7.2 0 3.9-3.9 6.9-8.8 6.9s-8.8-3-8.8-6.9c0-4 3.9-7.2 8.8-7.2z"/><path d="M6.5 14.9c3.6 2.3 9.1 2.4 13.3.2"/><circle cx="6.9" cy="13.3" r="1.25"/></svg>`;

// 木鱼（电子木鱼卡的**卡片主体**图标，30px）。这版是**从位图描摹**的真木鱼轮廓。
//
// 来源：silenceboychen/woodfish 的 `assets/images/muyu_icon.png`（460×460）。
// 流程：二值掩码（亮度 > 200）→ 沿前景/背景单位边提取闭合环 → Douglas-Peucker
//      简化到 24 点 → 归一化到 24×24 → 放大 0.86 居中烘焙进坐标。
// 脚本：`.workbuddy/checks/_trace.mjs`（描摹）+ `_bake1.mjs`（烘焙）。
//
// ⛔ 不画棒槌：用户要求「木鱼不要棍子了」。描摹版鱼身自带的凹口 + 共鸣孔在
//    30px 下已经足够辨认，加棒槌反而要把它缩到 0.5 倍。
//
// 和 ICON_MUYU 的分工：标题栏用上面那个手绘版（16px 下笔画更干净），
// 卡片主体用这个描摹版（30px 下轮廓更像真木鱼）。两个都别删。
export const ICON_MUYU_BIG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12.65 4.57C13.81 4.41 15.14 4.55 16.27 4.88C17.39 5.22 18.65 5.82 19.41 6.59C20.18 7.35 21.2 8.86 20.85 9.49C20.51 10.12 18.5 10.11 17.31 10.4C16.14 10.68 14.94 10.93 13.75 11.2C12.57 11.47 11.24 11.55 10.19 12C9.14 12.46 7.43 13.66 7.46 13.95C7.49 14.22 9.31 13.99 10.34 13.68C11.36 13.38 12.52 12.57 13.63 12.11C14.75 11.65 15.89 11.21 17.06 10.92C18.24 10.63 19.78 9.99 20.66 10.35C21.54 10.71 22.16 12.05 22.32 13.1C22.48 14.15 22.18 15.64 21.66 16.65C21.13 17.66 20.17 18.59 19.17 19.16C18.17 19.73 16.85 19.86 15.66 20.05C14.48 20.23 13.24 20.3 12.03 20.23C10.83 20.16 9.63 19.88 8.45 19.61C7.26 19.33 6.07 18.9 4.95 18.57C3.82 18.25 2.02 18.33 1.68 17.66C1.34 17 2.42 15.65 2.9 14.6C3.38 13.55 3.95 12.4 4.58 11.37C5.21 10.34 5.9 9.3 6.69 8.38C7.49 7.47 8.32 6.5 9.32 5.86C10.31 5.23 11.49 4.74 12.65 4.57Z"/></svg>`;

// 拖拽抓手（两列三点），用于「可拖动排序」的分组标题左侧
export const ICON_GRIP = `<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/></svg>`;

// 四角星芒（实心）：和 ICON_AI 同一个形状，但 fill 上色、不带描边。
// 灵感碎片星空卡的「一颗灵感一颗星」用它 —— 天上星星就该是这种细长的星芒，不是五角星。
export const ICON_SPARK = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2c.55 4.2 1.3 6.9 2.6 8.2 1.3 1.3 4 2.05 8.2 2.6-4.2.55-6.9 1.3-8.2 2.6-1.3 1.3-2.05 4-2.6 8.2-.55-4.2-1.3-6.9-2.6-8.2-1.3-1.3-4-2.05-8.2-2.6 4.2-.55 6.9-1.3 8.2-2.6 1.3-1.3 2.05-4 2.6-8.2z"/></svg>`;

// ===== 设置分区图标 =====
// 设置左侧导航用。全部线性 SVG，禁止 emoji —— emoji 会跟随系统字体渲染成彩色字形，
// 深浅主题下颜色失控，也和其余图标的 1.6 描边风格不搭。

// 外观：调色板（外框 + 三个颜料点 + 拇指孔）
export const ICON_PALETTE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.9 1.7-1.9 0-1.6 1.1-2.1 2.4-2.1H18a3.4 3.4 0 0 0 3-3.4C21 7.2 17 3 12 3z"/><circle cx="8" cy="9.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16" cy="9.5" r="1"/><circle cx="7.5" cy="14" r="1"/></svg>`;

// 隐私：挂锁（锁体 + 锁梁 + 钥匙孔）
export const ICON_LOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10.5" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.6v2.6"/></svg>`;

// 关于：信息圆（外圆 + 竖点 + 竖线）
export const ICON_INFO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.8h.01"/></svg>`;

// ===== 状态圆点（开关型按钮用）=====
// 用 SVG 圆而不是 ●/○ 字符：字符的字形宽度随字体变化，会让按钮左右跳。
export const ICON_DOT_ON = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="6"/></svg>`;
export const ICON_DOT_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="6"/></svg>`;

// 纯勾（无外圆）：皮肤卡 / 歌词配色菜单的「当前选中」标记。
// ICON_CHECK 带外圆，在这里会显得太重，所以单独做一个。
export const ICON_TICK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>`;

// ===== EMS 工作量统计（未完成 / 未验证 的需求与 Bug）=====
// 需求：文档页 + 折角 + 内文行（区别于 ICON_DOC 的文件语义，这里是「需求单」）
export const ICON_REQ = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5h7l5 5v14H6z"/><path d="M13 2.5v5h5"/><path d="M9 12h6"/><path d="M9 16h4"/></svg>`;
// Bug：瓢虫（鞘翅 + 中缝 + 触角）—— 比「虫子简笔画」更易在小尺寸辨认
export const ICON_BUG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6.5a4 4 0 0 1 8 0"/><ellipse cx="12" cy="14" rx="5.5" ry="6.5"/><path d="M12 7.5v13"/><path d="M7.2 10.5 4 8.5"/><path d="M16.8 10.5 20 8.5"/><path d="M6.7 14H3.5"/><path d="M17.3 14h3.2"/><path d="M7.2 17.5 4 19.5"/><path d="M16.8 17.5 20 19.5"/></svg>`;
// 未验证：盾牌 + 内部问号（「待校验」语义，不是「错误」）
export const ICON_VERIFY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 20 6v6c0 5-3.4 8.4-8 9.5C7.4 20.4 4 17 4 12V6z"/><path d="M9.8 9.8a2.3 2.3 0 0 1 4.5.6c0 1.6-2.3 1.9-2.3 3.4"/><path d="M12 17.2h.01"/></svg>`;

// 禅道卡（kind=ems）：层叠任务卡 + 勾。
// 「禅道」本体是项目/需求/Bug 的管理工具，语义上就是「一堆待办卡片里勾掉一条」。
// ⛔ 为什么不用 ICON_REQ：那是「文档 + 折角」，和卡片里「未验证需求」那一格
//    是同一个图标，标题栏和格子撞图；而且文档图标读不出「项目管理」。
// ⛔ 为什么不用禅圆 / 莲花：16px 下禅圆像加载转圈（会被误读成「正在刷新」），
//    莲花缩到 16px 糊成一团叶子。都是放大好看、实际尺寸不可用的典型。
// 构图：前卡（带勾）+ 后卡右上只留一个圆角直角。只画一条 L 形线，
//       16px 下不会糊；勾在卡片中心，和 ICON_CHECK（外圆+勾）形状不同，不撞。
export const ICON_KANBAN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 4.2h7.8a2 2 0 0 1 2 2v8.6"/><rect x="4.6" y="7.4" width="10.8" height="13.2" rx="2"/><path d="M7.4 13.4l2.2 2.2 4-4.2"/></svg>`;

// 新增（加号）：待办卡标题栏的「新增待办」入口。
// 用加号而不是「＋」文字：全站图标必须是 SVG（用户明确要求过不能用 emoji/文字符号）。
// 13px 渲染，落在「13-19px → stroke 1.8」这一档，和 .widget__open 同一视觉重量。
export const ICON_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5.5v13"/><path d="M5.5 12h13"/></svg>`;
