# SSH 远程 Yazi 图片预览实现说明

## 概述

OpsKat 当前已支持在桌面端 SSH 终端中为 `yazi` 提供图片预览能力。实现目标是保持 SSH PTY 兼容性的同时，在前端终端层接管 `Kitty unicode placeholders` 图像协议，将远端 `yazi` 输出的图片数据转为浏览器中的图片渲染。

当前实现聚焦以下范围：

- 远程 SSH 终端中的 `yazi` 图片预览
- `Kitty unicode placeholders` 协议
- 静态图片显示
- 分屏终端内独立图片层渲染

## 整体架构

实现分为两层：

1. SSH 会话层保持通用终端标识。
2. 前端终端层在写入 xterm 之前解析图片协议，并通过 overlay 渲染图片。

核心链路如下：

1. SSH 会话使用 `xterm-256color` 创建 PTY。
2. 远端 `yazi` 启动后向终端输出 Kitty 图像命令、placeholder 和终端探测序列。
3. 前端 `TerminalImageController` 从 `ssh:data:<sessionId>` 数据流中拦截并解析这些序列。
4. 普通终端文本继续写入 xterm。
5. 图片数据在浏览器中生成 object URL，并通过终端 wrapper 内的绝对定位 overlay 渲染。

## 后端会话层

文件：[`internal/service/ssh_svc/ssh.go`](/E:/goworkspace/opskat/internal/service/ssh_svc/ssh.go)

当前 SSH PTY 固定使用：

```go
const sshTerminalType = "xterm-256color"
```

这一层的职责是提供稳定的通用终端环境。图片预览能力由前端协议层补齐，SSH 会话层本身不直接承担图片协议解析。

## 前端接入点

### 终端实例注册

文件：[`frontend/src/components/terminal/terminalRegistry.ts`](/E:/goworkspace/opskat/frontend/src/components/terminal/terminalRegistry.ts)

每个 SSH 会话创建一个 `TerminalImageController` 实例，并绑定到对应的 xterm：

- `term.onData()` 负责把本地输入继续发回 SSH
- `EventsOn("ssh:data:" + sessionId, ...)` 接收远端字节流
- 接收到的数据先进入 `imageController.processIncoming(bytes)`
- 过滤后的普通文本再调用 `term.write(...)`

这保证了图片协议控制序列不会直接落到终端文本区域。

### 终端图片层

文件：[`frontend/src/components/terminal/Terminal.tsx`](/E:/goworkspace/opskat/frontend/src/components/terminal/Terminal.tsx)

终端组件在 wrapper 内挂载独立 overlay：

```tsx
<div ref={overlayRef} className="pointer-events-none absolute inset-0 z-20 overflow-hidden" />
```

该层具备以下特性：

- 绝对定位
- 不拦截鼠标事件
- 层级高于 xterm 画布
- 随终端 wrapper 生命周期挂载和卸载

`Terminal` 组件在以下时机触发图片重排：

- 初次挂载
- `fitAddon.fit()` 后
- `ResizeObserver` 监听到容器尺寸变化后
- pane 激活时
- 终端主题和字号更新后

## 图片协议解析器

文件：[`frontend/src/components/terminal/terminalImageProtocol.ts`](/E:/goworkspace/opskat/frontend/src/components/terminal/terminalImageProtocol.ts)

`TerminalImageController` 是当前图片预览实现的核心。

### 主要职责

- 解析远端输出中的 Kitty 图像命令
- 解析并记录 Unicode placeholder 位置
- 响应 `yazi` 启动阶段的终端能力探测
- 管理图片资源与 object URL
- 将图片映射到终端坐标并渲染到 overlay
- 在清屏、切屏、关闭连接时清理图片资源

### 当前支持的控制序列

#### Kitty 图像命令

- `a=q`
  - 用于图形能力探测
  - 返回 `\x1b_Gi=<id>;OK\x1b\\`
- `a=T`
  - 用于接收图片传输数据
  - 支持分段数据拼接
  - 支持 `U=1` 的 Unicode placeholder 模式
- `a=d`
  - 用于删除单张或全部图片

#### 终端探测响应

当前解析器会响应 `yazi` 启动时需要的探测序列：

- `CSI > q`
  - 返回 `\x1bP>|kitty 0.99.0\x1b\\`
- `CSI 16t`
  - 返回当前单元格像素尺寸
- `CSI 0c`
  - 返回设备属性 `\x1b[?62;c`
- `DCS $q q`
  - 返回光标形状响应 `\x1bP1$r0\x1b\\`
- `CSI ?12$p`
  - 返回光标闪烁状态 `\x1b[?12;1$y`
- `CSI ?u`
  - 返回键盘增强状态 `\x1b[?0u`

### Placeholder 定位

当前实现使用以下机制建立图片与终端区域的对应关系：

1. 解析 `SGR 38;2;r;g;b`，将 RGB 值还原为图片 ID。
2. 识别 `Kitty placeholder` 字符和两个组合附加符。
3. 根据当前光标行列记录图片占用的单元格范围。
4. 将多行多列 placeholder 合并为一个矩形区域。

最终记录的数据结构包含：

- `imageId`
- `bufferLine`
- `x`
- `rows`
- `columns`
- `generation`

## 图片资源处理

当前实现支持两类图片数据：

- `f=100`
  - 视为 PNG
  - 直接创建 `Blob`
- `f=24` 和 `f=32`
  - 视为原始 RGB / RGBA 像素数据
  - 先写入 canvas，再导出为 PNG object URL

资源处理流程如下：

1. 收集并拼接 base64 数据片段
2. 解码为 `Uint8Array`
3. 生成 `TerminalImageResource`
4. 创建 object URL
5. 在资源 generation 仍有效时触发重绘

## 布局与渲染

overlay 渲染时依赖以下信息：

- xterm 当前 cell 宽高
- wrapper 的 padding
- xterm viewport 的滚动偏移
- placeholder 对应的行列区域

渲染时每张图都会生成一个原生 `img` 元素，并设置：

- `position: absolute`
- `object-fit: contain`
- `pointer-events: none`
- 基于 cell 尺寸换算后的 `left`、`top`、`width`、`height`

只有位于当前可见窗口范围内的图片会被实际挂入 overlay。

## 生命周期与清理

当前实现会在以下场景清理图片状态：

- `ESC c`
- `CSI J` 中的清屏命令
- alternate screen 切换
- Kitty 删除命令 `a=d`
- 终端 overlay 卸载
- 会话关闭
- 控制器 `dispose()`

清理内容包括：

- `resources`
- `placements`
- 当前图片 ID
- overlay DOM
- 已创建的 object URL

## 用户开关

文件：

- [`frontend/src/stores/terminalThemeStore.ts`](/E:/goworkspace/opskat/frontend/src/stores/terminalThemeStore.ts)
- [`frontend/src/components/settings/AppearanceSection.tsx`](/E:/goworkspace/opskat/frontend/src/components/settings/AppearanceSection.tsx)

当前设置页提供实验开关：

- `启用 yazi 图片预览`

该开关控制 `TerminalImageController.setEnabled()`，关闭后图片层保持停用状态。

## 当前能力边界

当前实现已经覆盖：

- SSH 远程 `yazi` 启动时的终端探测响应
- Kitty placeholder 图片传输
- 终端内静态图片渲染
- 会话级图片状态管理
- 分屏场景下按 session 独立维护图片层

当前实现未扩展以下协议或能力：

- Sixel
- iTerm2 Inline Images
- 动态图动画播放
- tmux passthrough 专项适配
- 通用远程文件拉取型图片协议

## 相关文件

- [`internal/service/ssh_svc/ssh.go`](/E:/goworkspace/opskat/internal/service/ssh_svc/ssh.go)
- [`frontend/src/components/terminal/terminalRegistry.ts`](/E:/goworkspace/opskat/frontend/src/components/terminal/terminalRegistry.ts)
- [`frontend/src/components/terminal/Terminal.tsx`](/E:/goworkspace/opskat/frontend/src/components/terminal/Terminal.tsx)
- [`frontend/src/components/terminal/terminalImageProtocol.ts`](/E:/goworkspace/opskat/frontend/src/components/terminal/terminalImageProtocol.ts)
- [`frontend/src/stores/terminalThemeStore.ts`](/E:/goworkspace/opskat/frontend/src/stores/terminalThemeStore.ts)
- [`frontend/src/components/settings/AppearanceSection.tsx`](/E:/goworkspace/opskat/frontend/src/components/settings/AppearanceSection.tsx)
- [`frontend/src/__tests__/terminalImageProtocol.test.ts`](/E:/goworkspace/opskat/frontend/src/__tests__/terminalImageProtocol.test.ts)

## 验证覆盖

当前已有前端测试覆盖以下行为：

- Kitty 图片传输解析
- placeholder 转换与定位
- 删除与清屏清理
- 终端探测响应内容
- 同批探测响应顺序
- overlay 中图片节点渲染

