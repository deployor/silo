import { useState } from "react";
import { MdArrowForward } from "react-icons/md";
import { AppShell } from "../components/AppShell";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

function normalizeTypedCode(value: string) {
	const trimmed = value.trim();

	try {
		const parsed = new URL(trimmed);
		const code = parsed.searchParams.get("code");
		if (code) return normalizeTypedCode(code);
	} catch {
		// Normal code input, not a URL.
	}

	return value
		.toUpperCase()
		.replace(/[_\s]+/g, "-")
		.replace(/[^A-Z0-9-]/g, "")
		.replace(/-+/g, "-");
}

export function RedeemPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		success?: boolean;
		credits?: number;
		programName?: string;
		code?: string;
		error?: string;
	};
	const [code, setCode] = useState(() => normalizeTypedCode(p.code || ""));

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			<div className="silo-redeem">
				<header className="silo-redeem-header">
					<div>
						<p className="silo-redeem-eyebrow">Silo</p>
						<h1>Redeem storage</h1>
					</div>
				</header>

				{p.success ? (
					<section className="silo-redeem-success">
						<p className="silo-redeem-eyebrow is-success">Storage added</p>
						<p className="silo-redeem-amount">{formatBytes(p.credits || 0)}</p>
						<p className="silo-redeem-note">
							{p.programName
								? `Redeemed from ${p.programName}.`
								: "Code accepted."}
						</p>
						<a href="/" className="silo-dashboard-primary">
							Open dashboard
							<MdArrowForward aria-hidden="true" />
						</a>
					</section>
				) : (
					<form method="POST" action="/redeem" className="silo-redeem-form">
						<label htmlFor="code" className="silo-redeem-field">
							<span>Code</span>
							<input
								type="text"
								name="code"
								id="code"
								required
								value={code}
								onChange={(event) =>
									setCode(normalizeTypedCode(event.currentTarget.value))
								}
								autoComplete="one-time-code"
								inputMode="text"
								spellCheck={false}
								placeholder="PROGRAM-0000-0000"
							/>
						</label>

						{p.error ? <p className="silo-redeem-error">{p.error}</p> : null}

						<button
							type="submit"
							className="silo-dashboard-primary silo-redeem-submit"
						>
							Redeem
						</button>
					</form>
				)}

				<footer className="silo-redeem-footer">
					<span>Signed in as {p.user?.id || "user"}</span>
				</footer>
			</div>
		</AppShell>
	);
}
