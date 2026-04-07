import { useState } from "react";
import { AdminSubnav } from "../components/AdminSubnav";
import { AppShell } from "../components/AppShell";
import { PhIcon } from "../components/ui/PhIcon";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes, formatDate } from "../shared/utils/format";

type Program = {
	id: string;
	name: string;
	prefix: string;
	quotaCreditBytes: number;
};

type CodeRow = {
	code: string;
	isRedeemed: boolean;
	redeemedBy?: string | null;
	redeemedAt?: string | null;
};

type Pagination = {
	page: number;
	totalPages: number;
	total: number;
};

export function AdminRedemptionDetailsPage({
	bootstrap,
}: {
	bootstrap: AppBootstrap;
}) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		program: Program;
		codes?: CodeRow[];
		pagination?: Pagination;
	};
	const [open, setOpen] = useState(false);
	const codes = p.codes || [];
	const pagination = p.pagination || {
		page: 1,
		totalPages: 1,
		total: codes.length,
	};

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			<AdminSubnav active="redemptions" />

			<div className="space-y-6">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-4">
						<a
							href="/admin/redemptions"
							className="text-text-muted hover:text-white transition-colors"
						>
							<PhIcon className="ph ph-arrow-left text-2xl" />
						</a>
						<div>
							<h1 className="text-2xl font-bold text-white">
								{p.program.name}
							</h1>
							<p className="text-text-muted mt-1 font-mono text-sm">
								{p.program.prefix} • {formatBytes(p.program.quotaCreditBytes)}{" "}
								Credit
							</p>
						</div>
					</div>
					<div className="flex items-center gap-3">
						<form
							method="POST"
							action={`/admin/redemptions/${p.program.id}/export`}
							target="_blank"
							rel="noreferrer"
						>
							<button
								type="submit"
								className="px-4 py-2 bg-white/5 text-text-muted text-sm font-bold rounded-lg border border-white/10 hover:bg-white/10 hover:text-white transition-colors"
							>
								Export Codes (CSV)
							</button>
						</form>
						<button
							type="button"
							onClick={() => setOpen(true)}
							className="px-4 py-2 bg-hc-red text-white text-sm font-bold rounded-lg hover:bg-red-600 transition-colors shadow-lg shadow-red-900/20"
						>
							Generate Codes
						</button>
					</div>
				</div>

				<div className="grid grid-cols-1 md:grid-cols-3 gap-6">
					<div className="bg-hc-dark border border-white/10 rounded-3xl p-6 card-shadow">
						<h3 className="text-sm font-bold uppercase tracking-wider text-text-muted">
							Total Codes
						</h3>
						<p className="text-3xl font-bold text-white mt-2">
							{pagination.total}
						</p>
					</div>
				</div>

				<div className="bg-hc-dark border border-white/10 rounded-3xl overflow-hidden card-shadow">
					<div className="p-6 border-b border-white/10 flex justify-between items-center">
						<h3 className="font-bold text-white">Generated Codes</h3>
						<div className="flex gap-2 items-center">
							{pagination.page > 1 ? (
								<a
									href={`?page=${pagination.page - 1}`}
									className="px-3 py-1 bg-white/5 border border-white/10 text-white rounded-lg text-xs font-bold hover:bg-white/10 transition-colors"
								>
									Previous
								</a>
							) : null}
							<span className="text-text-muted text-xs py-1 font-mono">
								Page {pagination.page} of {pagination.totalPages}
							</span>
							{pagination.page < pagination.totalPages ? (
								<a
									href={`?page=${pagination.page + 1}`}
									className="px-3 py-1 bg-white/5 border border-white/10 text-white rounded-lg text-xs font-bold hover:bg-white/10 transition-colors"
								>
									Next
								</a>
							) : null}
						</div>
					</div>
					<div className="overflow-x-auto">
						<table className="w-full text-left text-sm">
							<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
								<tr>
									<th className="px-6 py-4">Code</th>
									<th className="px-6 py-4">Status</th>
									<th className="px-6 py-4">Redeemed By</th>
									<th className="px-6 py-4">Redeemed At</th>
									<th className="px-6 py-4 text-right">Link</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-white/5 font-mono text-xs">
								{codes.map((code) => (
									<tr
										key={code.code}
										className="hover:bg-white/5 transition-colors"
									>
										<td className="px-6 py-4 text-white select-all font-bold">
											{code.code}
										</td>
										<td className="px-6 py-4">
											{code.isRedeemed ? (
												<span className="bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded text-[10px] font-bold border border-emerald-500/30 uppercase tracking-wider">
													Redeemed
												</span>
											) : (
												<span className="bg-white/10 text-text-muted px-2 py-0.5 rounded text-[10px] font-bold border border-white/20 uppercase tracking-wider">
													Available
												</span>
											)}
										</td>
										<td className="px-6 py-4 text-text-muted">
											{code.redeemedBy || "-"}
										</td>
										<td className="px-6 py-4 text-text-muted">
											{code.redeemedAt ? formatDate(code.redeemedAt) : "-"}
										</td>
										<td className="px-6 py-4 text-right">
											<button
												type="button"
												onClick={() =>
													navigator.clipboard.writeText(
														`https://silo.deployor.dev/redeem?code=${code.code}`,
													)
												}
												className="text-hc-red hover:text-hc-red font-bold uppercase tracking-wider text-[10px]"
											>
												Copy Link
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			</div>

			{open ? (
				<div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
					<div className="bg-hc-dark rounded-3xl border border-white/10 p-8 w-full max-w-md card-shadow">
						<div className="flex justify-between items-center mb-6">
							<h3 className="text-2xl font-bold text-white">Generate Codes</h3>
							<button
								type="button"
								onClick={() => setOpen(false)}
								className="text-text-muted hover:text-white transition-colors"
							>
								<PhIcon className="ph ph-x text-2xl" />
							</button>
						</div>
						<form
							method="POST"
							action={`/admin/redemptions/${p.program.id}/generate`}
						>
							<label
								htmlFor="code-count"
								className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-2"
							>
								Number of Codes
							</label>
							<input
								id="code-count"
								type="number"
								name="count"
								required
								min={1}
								max={1000}
								defaultValue={10}
								className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white font-mono mb-6"
							/>
							<div className="flex justify-end gap-3">
								<button
									type="button"
									onClick={() => setOpen(false)}
									className="text-text-muted hover:text-white px-4 py-2 text-sm font-bold transition-colors"
								>
									Cancel
								</button>
								<button
									type="submit"
									className="bg-hc-red hover:bg-red-600 text-white px-6 py-3 rounded-xl text-sm font-bold transition-all"
								>
									Generate
								</button>
							</div>
						</form>
					</div>
				</div>
			) : null}
		</AppShell>
	);
}
