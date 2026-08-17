# DeskOverlay 产品架构设计文档 v1.0

> 产品代号：DeskOverlay\
> 定位：Windows Personal Operating Layer（Windows 个人桌面操作层）\
> 类型：桌面运行时 / 工作空间平台 / 插件化桌面系统\
> 技术基础：Tauri 2 + Rust + WebView2 + Win32 Desktop Integration

------------------------------------------------------------------------

# 1. 项目概述

DeskOverlay 不是传统桌面美化工具，而是一层运行于 Windows
桌面之上的个人工作空间系统。

传统模式：

Windows Explorer → 桌面图标 → 用户操作

DeskOverlay：

Windows → Explorer → DeskOverlay Runtime → Personal Workspace →
用户工作流

目标：让 HTML 成为 Windows 桌面的可编程交互层。

------------------------------------------------------------------------

# 2. 产品定位

DeskOverlay 是：

-   Windows 桌面操作层平台
-   工作流入口
-   信息聚合中心
-   AI Agent 宿主

不是：

-   普通 Widget 工具
-   壁纸工具
-   图标整理工具

------------------------------------------------------------------------

# 3. 核心架构

    Plugin Marketplace
            |
    Plugin Runtime
            |
    Panel Engine
            |
    Provider System
            |
    Desktop Runtime Core
            |
    Windows Explorer / Win32 API

------------------------------------------------------------------------

# 4. Desktop Runtime Core

负责：

-   Windows 桌面注入
-   WebView2 承载
-   生命周期管理
-   Explorer 重启恢复

核心：

Progman → WorkerW → DeskOverlay Window → WebView2 Canvas

------------------------------------------------------------------------

# 5. Panel Engine

每个面板支持：

-   拖动
-   缩放
-   最大化
-   锁定
-   隐藏
-   动画
-   状态保存
-   权限管理

示例：

``` json
{
  "id":"calendar",
  "component":"calendar-panel",
  "provider":"calendar",
  "theme":"glass"
}
```

------------------------------------------------------------------------

# 6. Provider 系统

Provider 是数据来源。

支持：

系统：

-   CPU
-   RAM
-   GPU
-   Network
-   Battery

应用：

-   Calendar
-   Git
-   Spotify
-   Cloud
-   Mail

AI：

-   Task Agent
-   File Agent
-   Search Agent

架构：

Provider → Data Collector → Event Bus → Panel Renderer

------------------------------------------------------------------------

# 7. Plugin SDK

目标：

允许第三方创建：

-   桌面组件
-   数据连接器
-   自动化工具
-   AI Agent

插件结构：

    plugin
     ├ manifest.json
     ├ panel.js
     ├ provider.js
     ├ style.css
     └ assets

------------------------------------------------------------------------

# 8. AI Desktop Agent

未来核心方向：

AI 作为桌面操作助手。

能力：

-   创建面板
-   调整布局
-   搜索文件
-   执行任务
-   管理信息

流程：

用户 → AI Agent → Tool System → Windows Actions → Desktop Workspace

------------------------------------------------------------------------

# 9. UI 设计规范

方向：

-   深色
-   半透明玻璃
-   克制高光
-   高信息密度

避免：

-   过度装饰
-   复杂动画
-   信息过载

------------------------------------------------------------------------

# 10. 多显示器

未来支持：

每个显示器独立：

-   WorkerW
-   WebView
-   工作空间
-   主题

------------------------------------------------------------------------

# 11. 开发路线

## Phase 0

技术验证：

-   桌面注入
-   WebView 覆盖
-   点击穿透
-   Explorer 自愈

## Phase 1

桌面运行时：

-   Panel Engine
-   配置系统
-   状态保存

## Phase 2

插件生态：

-   Plugin SDK
-   Marketplace
-   Provider 扩展

## Phase 3

AI Desktop：

-   AI Agent
-   自动布局
-   工作流自动化

## Phase 4

商业化：

-   云同步
-   Pro 功能
-   企业桌面

------------------------------------------------------------------------

# 12. 长期愿景

DeskOverlay 的目标：

成为 Windows 上的个人数字工作空间。

让桌面从：

"文件入口"

升级为：

"个人生产力操作系统"。
