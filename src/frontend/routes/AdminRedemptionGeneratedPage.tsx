import { useMemo, useState } from "react";
import { AppShell } from "../components/AppShell";
import { PhIcon } from "../components/ui/PhIcon";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type GeneratedCode = {
	code: string;
	quotaCreditBytes?: number | null;
};

export function AdminRedemptionGeneratedPage({
	bootstrap,
}: {
	bootstrap: AppBootstrap;
}) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		program?: { id: string; name: string };
		codes?: Array<string | GeneratedCode>;
	};
	const [rawCopied, setRawCopied] = useState(false);
	const [linksCopied, setLinksCopied] = useState(false);
	const codes = p.codes || [];

	const codeRows = useMemo(
		() =>
			codes.map((entry) =>
				typeof entry === "string" ? { code: entry } : entry,
			),
		[codes],
	);
	const raw = useMemo(
		() => codeRows.map((entry) => entry.code).join("\n"),
		[codeRows],
	);
	const links = useMemo(
		() =>
			codeRows
				.map((entry) => `https://dash.onsilo.dev/redeem?code=${entry.code}`)
				.join("\n"),
		[codeRows],
	);

	const copy = async (text: string, type: "raw" | "links"): Promise<void> => {
		await navigator.clipboard.writeText(text);
		if (type === "raw") {
			setRawCopied(true);
			setTimeout(() => setRawCopied(false), 2000);
		} else {
			setLinksCopied(true);
			setTimeout(() => setLinksCopied(false), 2000);
		}
	};

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			<div className="max-w-4xl mx-auto space-y-8">
				<div className="flex items-center gap-4">
					<a
						href={`/admin/redemptions/${p.program?.id || ""}`}
						className="text-text-muted hover:text-white transition-colors"
					>
						<PhIcon className="ph ph-arrow-left text-2xl" />
					</a>
					<div>
						<h1 className="text-2xl font-bold text-white">
							Codes Generated Successfully! 🎉
						</h1>
						<p className="text-text-muted mt-1">
							{codeRows.length} new codes created for{" "}
							<span className="text-white font-bold">{p.program?.name}</span>.
						</p>
					</div>
				</div>

				<div className="grid grid-cols-1 md:grid-cols-2 gap-8">
					<div className="bg-hc-dark border border-white/10 rounded-3xl p-6 card-shadow flex flex-col h-full">
						<div className="flex justify-between items-center mb-4">
							<h3 className="font-bold text-white text-lg">Raw Codes</h3>
							<button
								type="button"
								onClick={() => copy(raw, "raw")}
								className={`text-xs px-3 py-1.5 rounded-lg transition-colors font-bold uppercase tracking-wider ${
									rawCopied
										? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
										: "bg-white/10 hover:bg-white/20 text-white"
								}`}
							>
								{rawCopied ? "COPIED!" : "Copy All"}
							</button>
						</div>
						<textarea
							readOnly
							value={raw}
							className="w-full flex-grow bg-black/30 border border-white/10 rounded-xl p-4 text-sm font-mono text-text-muted focus:outline-none focus:border-hc-red transition-colors resize-none h-96 select-all"
						/>
						{codeRows.some((entry) => entry.quotaCreditBytes) ? (
							<p className="mt-3 text-xs text-text-muted font-mono">
								Custom amount:{" "}
								{formatBytes(
									codeRows.find((entry) => entry.quotaCreditBytes)
										?.quotaCreditBytes || 0,
								)}
							</p>
						) : null}
					</div>

					<div className="bg-hc-dark border border-white/10 rounded-3xl p-6 card-shadow flex flex-col h-full">
						<div className="flex justify-between items-center mb-4">
							<h3 className="font-bold text-white text-lg">Redemption Links</h3>
							<button
								type="button"
								onClick={() => copy(links, "links")}
								className={`text-xs px-3 py-1.5 rounded-lg transition-colors font-bold uppercase tracking-wider ${
									linksCopied
										? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
										: "bg-white/10 hover:bg-white/20 text-white"
								}`}
							>
								{linksCopied ? "COPIED!" : "Copy All"}
							</button>
						</div>
						<textarea
							readOnly
							value={links}
							className="w-full flex-grow bg-black/30 border border-white/10 rounded-xl p-4 text-sm font-mono text-text-muted focus:outline-none focus:border-hc-red transition-colors resize-none h-96 select-all"
						/>
					</div>
				</div>

				<div className="flex justify-center">
					<a
						href={`/admin/redemptions/${p.program?.id || ""}`}
						className="px-8 py-3 bg-hc-red hover:bg-red-600 text-white font-bold rounded-xl transition-all hover:scale-105 shadow-lg shadow-red-900/20"
					>
						Done & Return to Program
					</a>
				</div>
			</div>
		</AppShell>
	);
}
