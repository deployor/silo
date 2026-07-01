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
	apiKeySuffix?: string | null;
	apiKeyCreatedAt?: string | null;
};

type CodeRow = {
	code: string;
	quotaCreditBytes?: number | null;
	isRedeemed: boolean;
	redeemedBy?: string | null;
	redeemedAt?: string | null;
};

type Pagination = {
	page: number;
	totalPages: number;
	total: number;
};

type TransactionRow = {
	id: string;
	userId?: string | null;
	actorUserId?: string | null;
	source: string;
	externalId?: string | null;
	amountBytes: number;
	reason?: string | null;
	createdAt?: string | null;
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
		transactions?: TransactionRow[];
		transactionPagination?: Pagination;
		newApiKey?: string;
	};
	const [open, setOpen] = useState(false);
	const codes = p.codes || [];
	const pagination = p.pagination || {
		page: 1,
		totalPages: 1,
		total: codes.length,
	};
	const transactions = p.transactions || [];
	const defaultCodeAmount = p.program.quotaCreditBytes;

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
					<div className="bg-hc-dark border border-white/10 rounded-3xl p-6 card-shadow">
						<h3 className="text-sm font-bold uppercase tracking-wider text-text-muted">
							API Key
						</h3>
						<p className="text-3xl font-bold text-white mt-2">
							{p.program.apiKeySuffix ? `...${p.program.apiKeySuffix}` : "None"}
						</p>
					</div>
					<div className="bg-hc-dark border border-white/10 rounded-3xl p-6 card-shadow">
						<h3 className="text-sm font-bold uppercase tracking-wider text-text-muted">
							Transactions
						</h3>
						<p className="text-3xl font-bold text-white mt-2">
							{p.transactionPagination?.total || transactions.length}
						</p>
					</div>
				</div>

				{p.newApiKey ? (
					<div className="bg-emerald-500/10 border border-emerald-500/30 rounded-3xl p-6">
						<h3 className="text-white font-bold">Copy this API key now</h3>
						<p className="text-text-muted text-sm mt-1">
							It will not be shown again.
						</p>
						<code className="mt-4 block bg-black/40 border border-white/10 rounded-xl p-4 text-emerald-300 text-xs break-all select-all">
							{p.newApiKey}
						</code>
					</div>
				) : null}

				<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
					<div className="bg-hc-dark border border-white/10 rounded-3xl p-6 card-shadow">
						<div className="flex items-start justify-between gap-4">
							<div>
								<h3 className="font-bold text-white">Program API</h3>
								<p className="text-text-muted text-sm mt-1">
									Create codes or grant storage directly. Every grant is logged
									below.
								</p>
							</div>
							<form
								method="POST"
								action={`/admin/redemptions/${p.program.id}/api-key`}
							>
								<button
									type="submit"
									className="px-4 py-2 bg-white/5 border border-white/10 text-white rounded-lg text-xs font-bold hover:bg-white/10 transition-colors"
								>
									{p.program.apiKeySuffix ? "Rotate Key" : "Create Key"}
								</button>
							</form>
						</div>
						<div className="mt-5 space-y-4">
							<div>
								<p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-wider text-text-muted">
									Direct grant
								</p>
								<pre className="overflow-x-auto rounded-xl bg-black/30 p-4 text-xs text-text-muted">{`curl -X POST https://silo.deployor.dev/api/ysws/grants \\
  -H "Authorization: Bearer silo_ysws_..." \\
  -H "Content-Type: application/json" \\
  -d '{"email":"user@example.com","amount":10,"unit":"GB","externalId":"ysws-123"}'`}</pre>
							</div>
							<div>
								<p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-wider text-text-muted">
									Create codes
								</p>
								<pre className="overflow-x-auto rounded-xl bg-black/30 p-4 text-xs text-text-muted">{`curl -X POST https://silo.deployor.dev/api/ysws/codes \\
  -H "Authorization: Bearer silo_ysws_..." \\
  -H "Content-Type: application/json" \\
  -d '{"count":25,"amount":5,"unit":"GB","codes":["CUSTOM-ONE"]}'`}</pre>
							</div>
						</div>
					</div>

					<div className="bg-hc-dark border border-white/10 rounded-3xl p-6 card-shadow">
						<h3 className="font-bold text-white">Manual Grant</h3>
						<form
							method="POST"
							action={`/admin/redemptions/${p.program.id}/grant`}
							className="mt-4 space-y-3"
						>
							<input
								type="text"
								name="userId"
								placeholder="Silo user id"
								className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white"
							/>
							<div className="grid grid-cols-2 gap-3">
								<input
									type="email"
									name="email"
									placeholder="or email"
									className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white"
								/>
								<input
									type="text"
									name="slackId"
									placeholder="or Slack ID"
									className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white"
								/>
							</div>
							<div className="flex gap-2">
								<input
									type="number"
									name="amount"
									required
									defaultValue={p.program.quotaCreditBytes / 1024 ** 3}
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
							<input
								type="text"
								name="reason"
								placeholder="Reason"
								className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white"
							/>
							<button
								type="submit"
								className="w-full bg-hc-red hover:bg-red-600 text-white px-6 py-3 rounded-xl text-sm font-bold transition-all"
							>
								Grant Storage
							</button>
						</form>
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
									<th className="px-6 py-4">Credit</th>
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
										<td className="px-6 py-4 text-white">
											{formatBytes(code.quotaCreditBytes || defaultCodeAmount)}
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

				<div className="bg-hc-dark border border-white/10 rounded-3xl overflow-hidden card-shadow">
					<div className="p-6 border-b border-white/10">
						<h3 className="font-bold text-white">Recent Transactions</h3>
					</div>
					<div className="overflow-x-auto">
						<table className="w-full text-left text-sm">
							<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
								<tr>
									<th className="px-6 py-4">When</th>
									<th className="px-6 py-4">Source</th>
									<th className="px-6 py-4">User</th>
									<th className="px-6 py-4">Amount</th>
									<th className="px-6 py-4">External ID</th>
									<th className="px-6 py-4">Reason</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-white/5 font-mono text-xs">
								{transactions.length ? (
									transactions.map((transaction) => (
										<tr key={transaction.id}>
											<td className="px-6 py-4 text-text-muted">
												{transaction.createdAt
													? formatDate(transaction.createdAt)
													: "-"}
											</td>
											<td className="px-6 py-4 text-white uppercase">
												{transaction.source}
											</td>
											<td className="px-6 py-4 text-text-muted">
												{transaction.userId || "-"}
											</td>
											<td className="px-6 py-4 text-white">
												{formatBytes(transaction.amountBytes)}
											</td>
											<td className="px-6 py-4 text-text-muted">
												{transaction.externalId || "-"}
											</td>
											<td className="px-6 py-4 text-text-muted">
												{transaction.reason || "-"}
											</td>
										</tr>
									))
								) : (
									<tr>
										<td
											colSpan={6}
											className="px-6 py-8 text-center text-text-muted italic"
										>
											No transactions yet.
										</td>
									</tr>
								)}
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
								min={0}
								max={1000}
								defaultValue={10}
								className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-white font-mono mb-6"
							/>
							<label
								htmlFor="code-amount"
								className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-2"
							>
								Amount For These Codes
							</label>
							<div className="mb-6 flex gap-2">
								<input
									id="code-amount"
									type="number"
									name="amount"
									defaultValue={p.program.quotaCreditBytes / 1024 ** 3}
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
							<label
								htmlFor="custom-codes"
								className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-2"
							>
								Custom Codes
							</label>
							<textarea
								id="custom-codes"
								name="customCodes"
								rows={5}
								placeholder="One custom code per line. Prefix is added if missing."
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
