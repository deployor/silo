import { useState } from "react";
import { AdminSubnav } from "../components/AdminSubnav";
import { AppShell } from "../components/AppShell";
import { PhIcon } from "../components/ui/PhIcon";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type Program = {
	id: string;
	name: string;
	prefix: string;
	quotaCreditBytes: number;
	isActive: boolean;
};

export function AdminRedemptionsPage({
	bootstrap,
}: {
	bootstrap: AppBootstrap;
}) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		programs?: Program[];
	};
	const programs = p.programs || [];
	const [open, setOpen] = useState(false);

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			<AdminSubnav active="redemptions" />

			<div className="bg-hc-dark rounded-3xl border border-white/10 overflow-hidden card-shadow mb-8">
				<div className="p-6 border-b border-white/10 flex justify-between items-center">
					<div>
						<h2 className="text-xl font-bold text-white">
							Redemption Programs
						</h2>
						<p className="text-text-muted text-sm mt-1">
							Manage codes and quota grants for external programs.
						</p>
					</div>
					<button
						type="button"
						onClick={() => setOpen(true)}
						className="bg-white/5 hover:bg-white/10 border border-white/10 text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors"
					>
						+ New Program
					</button>
				</div>

				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
							<tr>
								<th className="px-6 py-4">Name</th>
								<th className="px-6 py-4">Prefix</th>
								<th className="px-6 py-4">Credit</th>
								<th className="px-6 py-4">Status</th>
								<th className="px-6 py-4 text-right">Actions</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-white/5">
							{programs.length ? (
								programs.map((program) => (
									<tr
										key={program.id}
										className="hover:bg-white/5 transition-colors"
									>
										<td className="px-6 py-4 font-medium text-white">
											{program.name}
										</td>
										<td className="px-6 py-4 font-mono text-xs text-text-muted">
											{program.prefix}
										</td>
										<td className="px-6 py-4 text-white font-mono">
											{formatBytes(program.quotaCreditBytes)}
										</td>
										<td className="px-6 py-4">
											{program.isActive ? (
												<span className="bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded text-xs font-bold border border-emerald-500/30">
													ACTIVE
												</span>
											) : (
												<span className="bg-white/10 text-text-muted px-2 py-0.5 rounded text-xs font-bold border border-white/20">
													INACTIVE
												</span>
											)}
										</td>
										<td className="px-6 py-4 text-right">
											<a
												href={`/admin/redemptions/${program.id}`}
												className="text-hc-blue hover:text-blue-400 text-xs font-bold uppercase tracking-wider"
											>
												Manage Codes
											</a>
										</td>
									</tr>
								))
							) : (
								<tr>
									<td
										colSpan={5}
										className="px-6 py-8 text-center text-text-muted italic"
									>
										No redemption programs created yet.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</div>

			{open ? (
				<div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
					<div className="bg-hc-dark rounded-3xl border border-white/10 p-8 w-full max-w-md card-shadow">
						<div className="flex justify-between items-center mb-6">
							<h3 className="text-2xl font-bold text-white">
								Create New Program
							</h3>
							<button
								type="button"
								onClick={() => setOpen(false)}
								className="text-text-muted hover:text-white transition-colors"
							>
								<PhIcon className="ph ph-x text-2xl" />
							</button>
						</div>
						<form method="POST" action="/admin/redemptions/create">
							<div className="mb-4">
								<label
									htmlFor="program-name"
									className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-2"
								>
									Program Name
								</label>
								<input
									id="program-name"
									type="text"
									name="name"
									required
									className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white"
								/>
							</div>
							<div className="mb-4">
								<label
									htmlFor="program-prefix"
									className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-2"
								>
									Code Prefix
								</label>
								<input
									id="program-prefix"
									type="text"
									name="prefix"
									required
									pattern="[A-Za-z0-9]+"
									className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white uppercase font-mono"
								/>
							</div>
							<div className="mb-4 flex gap-2">
								<input
									type="number"
									name="amount"
									required
									defaultValue={1}
									step="0.1"
									className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white"
								/>
								<select
									name="unit"
									className="bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white"
								>
									<option value={1024 ** 3}>GB</option>
									<option value={1024 ** 2}>MB</option>
									<option value={1024 ** 4}>TB</option>
								</select>
							</div>
							<div className="mb-6">
								<label
									htmlFor="program-description"
									className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-2"
								>
									Description
								</label>
								<textarea
									id="program-description"
									name="description"
									rows={3}
									className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white"
								/>
							</div>
							<div className="flex justify-end gap-3">
								<button
									type="button"
									onClick={() => setOpen(false)}
									className="text-text-muted hover:text-white px-4 py-2 text-sm font-bold"
								>
									Cancel
								</button>
								<button
									type="submit"
									className="bg-hc-blue hover:bg-blue-600 text-white px-6 py-3 rounded-xl text-sm font-bold"
								>
									Create Program
								</button>
							</div>
						</form>
					</div>
				</div>
			) : null}
		</AppShell>
	);
}
