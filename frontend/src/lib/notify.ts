import { toast } from "sonner";

// 成功类提示统一放到顶部居中：终端 / AI / 查询结果都是从下往上刷新，关键信息在底部，
// 提示落在底部（sonner 默认右下角）会遮挡正在刷新的输出（见 #135）。
// 错误 / 警告仍走 toast.error / toast.warning 留在右下角——报错文案长、需要停留细看，
// 顶部居中放不下太多内容。
const SUCCESS_POSITION = "top-center" as const;

// 复制 / 剪贴板确认：高频、扫一眼就行，1s 一闪而过即可。
export function notifyCopied(message: string) {
  toast.success(message, { position: SUCCESS_POSITION, duration: 1000 });
}

// 操作成功确认：顶部居中，沿用 sonner 默认停留时长。
export function notifySuccess(message: string) {
  toast.success(message, { position: SUCCESS_POSITION });
}
