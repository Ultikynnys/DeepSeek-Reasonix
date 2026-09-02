export type ToastItem = {
  id: number;
  msg: string;
  severity?: "error" | "warning" | "info" | "success";
  yolo?: boolean;
};

export function Toast({ message }: { message: { msg: string; yolo?: boolean } | null }) {
  if (!message) return null;
  if (message.yolo) {
    return (
      <div className="toast toast-yolo">
        <span className="toast-yolo-badge">YOLO</span>
        {message.msg}
      </div>
    );
  }
  return <div className="toast">{message.msg}</div>;
}

export function ToastStack({ items }: { items: ToastItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="toast-stack">
      {items.map((t) => {
        const cls = [
          "toast-item",
          t.severity ? `toast-${t.severity}` : "",
          t.yolo ? "toast-yolo" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div key={t.id} className={cls}>
            {t.yolo ? <span className="toast-yolo-badge">YOLO</span> : null}
            {t.severity === "error" ? <span className="toast-icon">✕</span> : null}
            {t.severity === "warning" ? <span className="toast-icon">⚠</span> : null}
            {t.severity === "info" ? <span className="toast-icon">ℹ</span> : null}
            {t.severity === "success" ? <span className="toast-icon">✓</span> : null}
            <span className="toast-msg">{t.msg}</span>
          </div>
        );
      })}
    </div>
  );
}
