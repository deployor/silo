import { AdminSubnav } from "../components/AdminSubnav";
import { AppShell } from "../components/AppShell";
import { PhIcon } from "../components/ui/PhIcon";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatDate } from "../shared/utils/format";

type Submission = {
	id: string;
	projectName: string;
	shortDescription?: string;
	userId: string;
	hoursSpent: number;
	status: "pending" | "approved" | "rejected";
	createdAt?: string;
};

function statusClass(status: Submission["status"]): string {
	if (status === "pending") {
		return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
	}
	if (status === "approved") {
		return "bg-red-500/10 text-hc-red border-red-500/20";
	}
	return "bg-red-500/10 text-red-400 border-red-500/20";
}

export function AdminYswsListPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		submissions?: Submission[];
	};
	const submissions = p.submissions || [];

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			<AdminSubnav active="ysws" />

			<div className="bg-hc-dark rounded-3xl border border-white/10 overflow-hidden card-shadow mb-8">
				<div className="p-6 border-b border-white/10 flex justify-between items-center">
					<div>
						<h2 className="text-xl font-bold text-white">YSWS Submissions</h2>
						<p className="text-text-muted text-sm mt-1">
							Review submissions and award storage quota.
						</p>
					</div>
				</div>

				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
							<tr>
								<th className="px-6 py-4">Project</th>
								<th className="px-6 py-4">User</th>
								<th className="px-6 py-4">Hours</th>
								<th className="px-6 py-4">Status</th>
								<th className="px-6 py-4">Submitted</th>
								<th className="px-6 py-4" />
							</tr>
						</thead>
						<tbody className="divide-y divide-white/5">
							{submissions.length ? (
								submissions.map((submission) => (
									<tr
										key={submission.id}
										className="hover:bg-white/5 transition-colors"
									>
										<td className="px-6 py-4 font-medium">
											<div className="text-white">{submission.projectName}</div>
											<div className="text-xs text-text-muted truncate max-w-[200px]">
												{submission.shortDescription}
											</div>
										</td>
										<td className="px-6 py-4 font-mono text-xs text-text-muted">
											{submission.userId}
										</td>
										<td className="px-6 py-4">{submission.hoursSpent}h</td>
										<td className="px-6 py-4">
											<span
												className={`px-2 py-1 rounded-full text-xs border ${statusClass(
													submission.status,
												)}`}
											>
												{submission.status === "pending"
													? "Pending"
													: submission.status === "approved"
														? "Approved"
														: "Rejected"}
											</span>
										</td>
										<td className="px-6 py-4 text-text-muted">
											{formatDate(submission.createdAt)}
										</td>
										<td className="px-6 py-4 text-right">
											<a
												href={`/admin/ysws/${submission.id}`}
												className="text-hc-red hover:text-white transition-colors font-medium flex items-center justify-end gap-1"
											>
												Review
												<PhIcon className="ph ph-arrow-right" />
											</a>
										</td>
									</tr>
								))
							) : (
								<tr>
									<td
										colSpan={6}
										className="px-6 py-12 text-center text-text-muted"
									>
										No submissions found.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</div>
		</AppShell>
	);
}
