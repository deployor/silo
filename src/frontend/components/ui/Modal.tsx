import type React from "react";
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
	if (!open) return null;

	return (
		<div className="fixed inset-0 flex items-center justify-center z-50 p-4">
			{onClose ? (
				<button
					type="button"
					aria-label="Close modal"
					className="absolute inset-0 bg-black/80"
					onClick={onClose}
				/>
			) : (
				<div className="absolute inset-0 bg-black/80" />
			)}
			<div
				className={`relative z-10 bg-hc-dark rounded-3xl border border-white/10 w-full max-h-[90vh] overflow-y-auto card-shadow ${className ?? "max-w-3xl p-8"}`}
			>
				{title ? (
					<div className="flex justify-between items-center mb-6 pb-4 border-b border-white/10">
						<h3 className="text-2xl font-bold text-white">{title}</h3>
						{onClose ? (
							<button
								type="button"
								onClick={onClose}
								className="text-text-muted hover:text-white transition-colors rounded-lg p-1 hover:bg-white/5"
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
