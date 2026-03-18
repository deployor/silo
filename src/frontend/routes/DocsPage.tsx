import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../components/AppShell";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";

type Section = {
	id: string;
	label: string;
	group: string;
	content: React.ReactNode;
};

export function DocsPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		yswsQuotaPerHour?: number;
		yswsBonusTiers?: Array<{
			hours: number;
			percent: number;
			enabled: boolean;
		}>;
	};

	const [mobileOpen, setMobileOpen] = useState(false);
	const [hours, setHours] = useState(10);
	const [active, setActive] = useState("intro");

	const sections = useMemo<Section[]>(() => {
		const tiers = (p.yswsBonusTiers || [])
			.filter((t) => t.enabled)
			.sort((a, b) => b.hours - a.hours);
		const tier = tiers.find((t) => hours >= t.hours);
		const bonus = tier ? tier.percent : 0;
		const rate = p.yswsQuotaPerHour || 0;
		const rewardGb = (
			(hours * rate * (1 + bonus / 100)) /
			(1024 * 1024 * 1024)
		).toFixed(1);

		return [
			{
				id: "intro",
				label: "Introduction",
				group: "Basics",
				content: (
					<>
						<h1 className="text-4xl font-bold mb-6 text-white">Introduction</h1>
						<p className="text-lg mb-6 text-text-muted leading-relaxed">
							Silo is free S3 storage for Hack Clubbers.
						</p>
						<p className="text-lg mb-6 text-text-muted leading-relaxed">
							If you're a teen building something and need storage for a game,
							website, or hackathon project, this is for you.
						</p>
						<p className="text-lg mb-6 text-text-muted leading-relaxed">
							Under the hood, Silo proxies requests into a single backing bucket
							while enforcing auth and quotas.
						</p>
					</>
				),
			},
			{
				id: "ysws",
				label: "YSWS Program",
				group: "Basics",
				content: (
					<>
						<h1 className="text-4xl font-bold mb-6 text-white">YSWS Program</h1>
						<p className="text-lg mb-6 text-text-muted leading-relaxed">
							"You Ship, We Ship" lets you earn permanent storage by shipping
							projects.
						</p>
						<div className="mt-8 mb-12 border border-white/10 rounded-3xl p-8 bg-hc-darker/50">
							<h3 className="text-text-muted text-sm font-bold uppercase tracking-wider mb-6 text-center">
								Reward Calculator
							</h3>
							<div className="flex flex-col md:flex-row gap-8 items-center">
								<div className="flex-1 w-full">
									<div className="flex justify-between items-end mb-4">
										<label
											htmlFor="docs-hours"
											className="text-sm font-bold text-white"
										>
											Hours Spent Coding
										</label>
										<span className="text-2xl font-bold text-hc-red font-mono">
											{hours}h
										</span>
									</div>
									<input
										id="docs-hours"
										type="range"
										min={1}
										max={100}
										value={hours}
										onChange={(e) => setHours(Number(e.target.value))}
										className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-hc-red"
									/>
								</div>
								<div className="hidden md:block w-px h-24 bg-white/10" />
								<div className="flex-1 w-full text-center md:text-left">
									<p className="text-text-muted text-xs font-bold uppercase tracking-wider mb-2">
										You Earn
									</p>
									<div className="flex items-baseline justify-center md:justify-start gap-2">
										<span className="text-5xl font-bold text-white tracking-tighter">
											{rewardGb}
										</span>
										<span className="text-xl text-white/40 font-bold">GB</span>
									</div>
									{bonus > 0 ? (
										<p className="text-xs text-hc-green font-bold mt-2">
											+{bonus}% bonus applied
										</p>
									) : null}
								</div>
							</div>
						</div>
						<ol className="list-decimal list-inside space-y-4 text-text-muted mb-8">
							<li>Build a project using Silo.</li>
							<li>
								Go to{" "}
								<a href="/ysws" className="text-hc-red hover:underline">
									YSWS Dashboard
								</a>
								.
							</li>
							<li>Submit project details and hours spent.</li>
							<li>Once approved, your quota increases automatically.</li>
						</ol>
					</>
				),
			},
			{
				id: "auth",
				label: "Authentication",
				group: "Basics",
				content: (
					<>
						<h1 className="text-4xl font-bold mb-6 text-white">
							Authentication
						</h1>
						<ol className="list-decimal list-inside space-y-4 text-text-muted mb-8">
							<li>Log in to the dashboard.</li>
							<li>Create a bucket.</li>
							<li>Copy Access Key and Secret Key.</li>
						</ol>
					</>
				),
			},
			{
				id: "public-buckets",
				label: "Public Buckets",
				group: "Basics",
				content: (
					<>
						<h1 className="text-4xl font-bold mb-6 text-white">
							Public Buckets
						</h1>
						<p className="text-lg mb-6 text-text-muted">
							Public buckets allow unauthenticated <code>GetObject</code> and{" "}
							<code>HeadObject</code>.
						</p>
						<p className="text-text-muted">
							Great for static assets and browser-hosted files.
						</p>
					</>
				),
			},
			{
				id: "cors",
				label: "CORS Configuration",
				group: "Basics",
				content: (
					<>
						<h1 className="text-4xl font-bold mb-6 text-white">
							CORS Configuration
						</h1>
						<p className="text-lg mb-6 text-text-muted">
							Silo supports virtual per-bucket CORS handled at proxy level.
						</p>
						<pre className="rounded-lg mb-6 bg-black/40 p-4 overflow-auto text-sm">
							<code>{`{
  "CORSRules": [{
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["https://myapp.com"]
  }]
}`}</code>
						</pre>
					</>
				),
			},
			{
				id: "supported-api",
				label: "Supported Operations",
				group: "API Reference",
				content: (
					<>
						<h1 className="text-4xl font-bold mb-6 text-white">
							Supported Operations
						</h1>
						<ul className="list-disc list-inside space-y-2 text-text-muted font-mono text-sm">
							<li>ListBuckets, HeadBucket, GetBucketLocation</li>
							<li>PutObject, GetObject, HeadObject, DeleteObject</li>
							<li>ListObjectsV2, DeleteObjects, Multipart Upload APIs</li>
						</ul>
					</>
				),
			},
			{
				id: "endpoints",
				label: "Endpoints & Regions",
				group: "API Reference",
				content: (
					<>
						<h1 className="text-4xl font-bold mb-6 text-white">
							Endpoints & Regions
						</h1>
						<p className="text-text-muted mb-2">
							Region: <code>eu-central-1</code>
						</p>
						<p className="text-text-muted mb-2">
							Endpoint: <code>https://silo.deployor.dev</code>
						</p>
					</>
				),
			},
			{
				id: "limits",
				label: "Limits & Quotas",
				group: "API Reference",
				content: (
					<>
						<h1 className="text-4xl font-bold mb-6 text-white">
							Limits & Quotas
						</h1>
						<ul className="list-disc list-inside space-y-2 text-text-muted">
							<li>Storage limit per user.</li>
							<li>Egress limit is typically 3× storage limit.</li>
						</ul>
					</>
				),
			},
			{
				id: "aws-cli",
				label: "AWS CLI",
				group: "Examples",
				content: (
					<>
						<h1 className="text-4xl font-bold mb-6 text-white">AWS CLI</h1>
						<pre className="rounded-lg bg-black/40 p-4 overflow-auto text-sm">
							<code>{`aws configure --profile silo
aws s3 ls --endpoint-url https://silo.deployor.dev --profile silo`}</code>
						</pre>
					</>
				),
			},
			{
				id: "js",
				label: "JavaScript / Bun",
				group: "Examples",
				content: (
					<>
						<h1 className="text-4xl font-bold mb-6 text-white">
							JavaScript / TypeScript
						</h1>
						<pre className="rounded-lg bg-black/40 p-4 overflow-auto text-sm">
							<code>{`import { S3Client } from "@aws-sdk/client-s3";
const s3 = new S3Client({ endpoint: "https://silo.deployor.dev", region: "auto" });`}</code>
						</pre>
					</>
				),
			},
			{
				id: "python",
				label: "Python (Boto3)",
				group: "Examples",
				content: (
					<h1 className="text-4xl font-bold mb-6 text-white">Python (Boto3)</h1>
				),
			},
			{
				id: "go",
				label: "Go",
				group: "Examples",
				content: <h1 className="text-4xl font-bold mb-6 text-white">Go</h1>,
			},
			{
				id: "rclone",
				label: "Rclone",
				group: "Examples",
				content: <h1 className="text-4xl font-bold mb-6 text-white">Rclone</h1>,
			},
		];
	}, [hours, p.yswsBonusTiers, p.yswsQuotaPerHour]);

	useEffect(() => {
		const hash = window.location.hash.replace("#", "");
		if (hash && sections.some((s) => s.id === hash)) setActive(hash);
	}, [sections]);

	const groups = useMemo(() => {
		const g = new Map<string, Section[]>();
		for (const s of sections) {
			const arr = g.get(s.group) || [];
			arr.push(s);
			g.set(s.group, arr);
		}
		return Array.from(g.entries());
	}, [sections]);

	const activeSection = sections.find((s) => s.id === active) || sections[0];

	const setSection = (id: string) => {
		setActive(id);
		window.history.replaceState(null, "", `#${id}`);
		if (window.innerWidth < 768) setMobileOpen(false);
	};

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			<div className="flex flex-1 max-w-7xl mx-auto w-full">
				<aside
					className={`fixed inset-0 z-40 bg-hc-dark p-6 overflow-y-auto transition-transform duration-300 ${mobileOpen ? "translate-x-0" : "-translate-x-full"} md:translate-x-0 md:relative md:inset-auto md:w-64 md:block md:h-[calc(100vh-65px)] md:sticky md:top-[65px] md:border-r md:border-white/10`}
				>
					<div className="md:hidden flex justify-between items-center mb-6">
						<span className="font-bold text-white">Navigation</span>
						<button
							type="button"
							onClick={() => setMobileOpen(false)}
							className="text-text-muted hover:text-white"
						>
							<i className="ph ph-x text-2xl" />
						</button>
					</div>

					<div className="space-y-8">
						{groups.map(([group, groupSections]) => (
							<div key={group}>
								<h5 className="font-bold text-text-muted text-xs uppercase tracking-wider mb-3 pl-3">
									{group}
								</h5>
								<ul className="space-y-1 text-sm font-medium">
									{groupSections.map((s) => (
										<li key={s.id}>
											<button
												type="button"
												onClick={() => setSection(s.id)}
												className={`text-left w-full transition-colors py-2 px-3 rounded-lg ${active === s.id ? "bg-white/10 text-white" : "text-text-muted hover:text-white"}`}
											>
												{s.label}
											</button>
										</li>
									))}
								</ul>
							</div>
						))}
					</div>
				</aside>

				<main className="flex-1 max-w-3xl min-w-0">
					<div className="md:hidden sticky top-[65px] z-30 bg-hc-darker/95 backdrop-blur-md border-b border-white/10 px-6 py-3 mb-6">
						<button
							type="button"
							onClick={() => setMobileOpen(true)}
							className="flex items-center gap-2 text-sm font-bold text-text-muted hover:text-white transition-colors"
						>
							<i className="ph ph-list text-xl" /> Table of Contents
						</button>
					</div>
					<div className="p-6 md:p-12 pt-0 md:pt-12">
						{activeSection.content}
					</div>
				</main>
			</div>
		</AppShell>
	);
}
