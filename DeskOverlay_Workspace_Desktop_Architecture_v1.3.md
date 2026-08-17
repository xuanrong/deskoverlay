# DeskOverlay 工作台即桌面架构设计文档 v1.3

> 核心定位：Windows Workspace is Desktop\
> 技术核心：WorkerW 注入 + WebView2 + Rust Runtime

## 1. 核心理念

DeskOverlay 不是桌面插件，而是重新定义 Windows 桌面。

传统：

Windows Explorer → 桌面图标 → 用户操作

DeskOverlay：

Windows → Explorer → WorkerW → DeskOverlay Runtime → HTML 工作台

核心原则：

> 工作台即桌面。

------------------------------------------------------------------------

## 2. WorkerW 桌面注入架构

核心窗口链：

    Progman
      ↓
    WorkerW
      ↓
    DeskOverlay Window
      ↓
    WebView2 Canvas
      ↓
    HTML Workspace

WorkerW 作为桌面承载层。

优势：

-   与 Windows 桌面自然融合
-   不使用普通悬浮窗口
-   不抢占用户操作
-   支持桌面级渲染

------------------------------------------------------------------------

## 3. Desktop Runtime Core

核心模块：

    desktop_inject
     ├ WorkerW查找
     ├ SetParent注入
     └ Explorer恢复

    workspace_engine
     ├ Layout管理
     ├ Panel管理
     └ 状态保存

    window_manager
     ├ DPI处理
     ├ 多屏管理

    hit_test
     └ WM_NCHITTEST

    provider_runtime
     └ 数据服务

------------------------------------------------------------------------

## 4. 工作台 Workspace Engine

工作台是核心产品。

不是 Widget 集合。

而是一个永久存在于桌面的应用环境。

结构：

    Workspace

    ├ Layout
    ├ Panels
    ├ Applications
    ├ Shortcuts
    ├ AI Actions
    └ User Data

------------------------------------------------------------------------

## 5. Panel 系统

Panel 是工作台功能模块。

支持：

-   拖动
-   缩放
-   固定
-   隐藏
-   折叠
-   自动布局

示例：

    桌面

    +----------------+
    | 今日任务        |
    | Todo           |
    | Calendar       |
    +----------------+

    +----------------+
    | System Monitor |
    | CPU 25%        |
    +----------------+

------------------------------------------------------------------------

## 6. 桌面交互模型

面板区域：

    WM_NCHITTEST

    HTCLIENT

    ↓

    WebView交互

空白区域：

    WM_NCHITTEST

    HTTRANSPARENT

    ↓

    真实Windows桌面

目标：

工作台可操作，同时保持 Windows 桌面体验。

------------------------------------------------------------------------

## 7. 原生桌面处理

启动后隐藏 Explorer 原生图标层。

用户看到：

    DeskOverlay Workspace

而不是：

    文件图标 + 壁纸

Explorer 保留系统能力。

------------------------------------------------------------------------

## 8. Provider 数据系统

Provider 提供工作台数据。

类型：

系统： - CPU - GPU - RAM - 网络

工作： - Todo - Calendar - Git - 文件

AI： - Agent状态 - 自动任务

数据流：

    Provider

    ↓

    Rust Event Bus

    ↓

    Workspace Renderer

    ↓

    Panel更新

------------------------------------------------------------------------

## 9. 工作空间配置

布局数据化：

``` json
{
 "workspace":"coding",
 "panels":[
   {
    "id":"git",
    "x":40,
    "y":40
   }
 ]
}
```

支持：

-   多工作空间
-   布局保存
-   模式切换

------------------------------------------------------------------------

## 10. AI Desktop

AI 是工作台控制器。

例如：

用户：

进入开发模式

执行：

    workspace.switch(code)

    显示:
    Git
    Terminal
    Server

    隐藏:
    娱乐组件

AI 可以：

-   创建面板
-   调整布局
-   调用 Provider
-   切换工作环境

------------------------------------------------------------------------

## 11. 自愈机制

Runtime Monitor：

负责：

-   Explorer重启检测
-   WorkerW重新注入
-   WebView恢复
-   状态恢复

目标：

Explorer 崩溃后用户无感恢复。

------------------------------------------------------------------------

## 12. 开发路线

### Phase 0

WorkerW Runtime

-   WorkerW注入
-   WebView2承载
-   Explorer恢复

### Phase 1

Desktop Workspace

-   Panel系统
-   布局系统
-   状态保存

### Phase 2

Provider生态

-   系统数据
-   工作数据
-   插件扩展

### Phase 3

AI Workspace

-   AI布局控制
-   自动工作模式
-   Agent能力

------------------------------------------------------------------------

## 13. 最终愿景

DeskOverlay：

不是桌面插件。

而是：

    Windows Desktop

    +

    Workspace Runtime

    +

    AI Operating Layer

目标：

让桌面从文件入口，升级为用户每天工作的数字空间。
