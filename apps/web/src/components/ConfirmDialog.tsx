import { useEffect, useRef } from "react";

interface Props {
  title: string;
  body: string;
  confirm: string;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({ title, body, confirm, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog ref={ref} className="dialog" onCancel={onCancel} aria-labelledby="dialog-title">
      <h2 id="dialog-title">{title}</h2>
      <p>{body}</p>
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel}>
          Keep working
        </button>
        <button className="btn btn-primary" onClick={onConfirm} data-testid="confirm-submit">
          {confirm}
        </button>
      </div>
    </dialog>
  );
}
