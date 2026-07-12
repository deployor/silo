import type React from "react";
import { useEffect, useId } from "react";
import { PhIcon } from "./PhIcon";

type ModalProps = {
	open: boolean;
	onClose?: () => void;
	title?: string;
	className?: string;
	children: React.ReactNode;
};

export function Modal({
	open,
	onClose,
	title,
	className,
	children,
}: ModalProps) {
	const titleId = useId();

	useEffect(() => {
		if (!open || !onClose) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);

	if (!open) return null;

	return (
		<div className="fixed inset-0 flex items-center justify-center z-50 p-4">
			{onClose ? (
				<button
					type="button"
					aria-label="Close modal"
					className="absolute inset-0 silo-modal-overlay"
					onClick={onClose}
				/>
			) : (
				<div className="absolute inset-0 silo-modal-overlay" />
			)}
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby={title ? titleId : undefined}
				className={`relative z-10 w-full max-h-[90vh] overflow-y-auto rounded-3xl silo-modal-panel ${className ?? "max-w-3xl p-8"}`}
			>
				{title ? (
					<div className="silo-modal-header flex justify-between items-center mb-6 pb-4 border-b border-white/10">
						<h3 id={titleId} className="text-2xl font-bold text-white">
							{title}
						</h3>
						{onClose ? (
							<button
								type="button"
								onClick={onClose}
								className="text-text-muted hover:text-white transition-colors rounded-lg p-2 hover:bg-white/5 min-h-11 min-w-11 inline-flex items-center justify-center"
								aria-label="Close modal"
							>
								<PhIcon className="ph ph-x text-2xl" />
							</button>
						) : null}
					</div>
				) : null}
				{children}
			</div>
		</div>
	);
}
