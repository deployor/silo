import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../components/AppShell";
import { PhIcon } from "../components/ui/PhIcon";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";

type Section = {
	id: string;
	label: string;
	group: "Basics" | "API Reference" | "Examples";
};

function CodeBlock({ code }: { code: string }) {
	return (
		<pre className="rounded-lg mb-6 bg-black/40 p-4 overflow-auto text-sm">
			<code>{code}</code>
		</pre>
	);
}

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

	const sections = useMemo<Section[]>(
		() => [
			{ id: "intro", label: "Introduction", group: "Basics" },
			{ id: "ysws", label: "YSWS Program", group: "Basics" },
			{ id: "auth", label: "Authentication", group: "Basics" },
			{ id: "custom-domains", label: "Custom Domains", group: "Basics" },
			{
				id: "public-buckets",
				label: "Public Buckets",
				group: "Basics",
			},
			{ id: "cors", label: "CORS Configuration", group: "Basics" },
			{
				id: "supported-api",
				label: "Supported Operations",
				group: "API Reference",
			},
			{
				id: "endpoints",
				label: "Endpoints & Regions",
				group: "API Reference",
			},
			{ id: "limits", label: "Limits & Quotas", group: "API Reference" },
			{ id: "aws-cli", label: "AWS CLI", group: "Examples" },
			{ id: "js", label: "JavaScript / Bun", group: "Examples" },
			{ id: "python", label: "Python (Boto3)", group: "Examples" },
			{ id: "go", label: "Go", group: "Examples" },
			{ id: "rclone", label: "Rclone", group: "Examples" },
		],
		[],
	);

	const groups = useMemo(() => {
		const g = new Map<string, Section[]>();
		for (const s of sections) {
			const arr = g.get(s.group) || [];
			arr.push(s);
			g.set(s.group, arr);
		}
		return Array.from(g.entries());
	}, [sections]);

	const tiers = useMemo(
		() =>
			(p.yswsBonusTiers || [])
				.filter((t) => t.enabled)
				.sort((a, b) => b.hours - a.hours),
		[p.yswsBonusTiers],
	);
	const activeTier = tiers.find((t) => hours >= t.hours);
	const activeTierBonus = activeTier ? activeTier.percent : 0;
	const finalRewardGb = (
		(hours * (p.yswsQuotaPerHour || 0) * (1 + activeTierBonus / 100)) /
		(1024 * 1024 * 1024)
	).toFixed(1);

	useEffect(() => {
		const hash = window.location.hash.replace("#", "");
		if (hash && sections.some((s) => s.id === hash)) {
			setActive(hash);
			return;
		}
		setActive("intro");
	}, [sections]);

	useEffect(() => {
		document.body.style.overflow = mobileOpen ? "hidden" : "";
		return () => {
			document.body.style.overflow = "";
		};
	}, [mobileOpen]);

	const setSection = (id: string) => {
		setActive(id);
		window.history.pushState(null, "", `#${id}`);
		if (window.innerWidth < 768) {
			setMobileOpen(false);
		}
	};

	const activeSection = active;

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
		>
			<div className="flex flex-1 max-w-7xl mx-auto w-full">
				<aside
					id="docs-sidebar"
					className={`fixed inset-0 z-40 bg-hc-dark p-6 overflow-y-auto transition-transform duration-300 ${mobileOpen ? "translate-x-0" : "-translate-x-full"} md:translate-x-0 md:relative md:inset-auto md:w-64 md:block md:h-[calc(100vh-65px)] md:sticky md:top-[65px] md:border-r md:border-white/10`}
				>
					<div className="md:hidden flex justify-between items-center mb-6">
						<span className="font-bold text-white">Navigation</span>
						<button
							type="button"
							onClick={() => setMobileOpen(false)}
							className="text-text-muted hover:text-white"
						>
							<PhIcon className="ph ph-x text-2xl" />
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
							<PhIcon className="ph ph-list text-xl" />
							Table of Contents
						</button>
					</div>

					<div className="p-6 md:p-12 pt-0 md:pt-12">
						{activeSection === "intro" ? (
							<div id="intro" className="section-content active">
								<h1 className="text-4xl font-bold mb-6 text-white">
									Introduction
								</h1>
								<p className="text-lg mb-6 text-text-muted leading-relaxed">
									Silo is free S3 storage for Hack Clubbers.
								</p>
								<p className="text-lg mb-6 text-text-muted leading-relaxed">
									If you're a teen building something and need storage whether
									it's for a game, a website, or a hackathon project, this is
									for you.
								</p>
								<p className="text-lg mb-6 text-text-muted leading-relaxed">
									Under the hood, we just proxy all requests into one single
									bucket under routes. This lets us handle the boring stuff
									(like quotas and auth) while giving you a standard S3 API. You
									can use all the normal tools (AWS CLI, libraries, etc.)
									without needing a credit card, a cloudflare account etc.
								</p>
								<p className="text-lg mb-6 text-text-muted leading-relaxed">
									Just log in and start shipping.
								</p>
							</div>
						) : null}

						{activeSection === "ysws" ? (
							<div id="ysws" className="section-content active">
								<h1 className="text-4xl font-bold mb-6 text-white">
									YSWS Program
								</h1>
								<p className="text-lg mb-6 text-text-muted leading-relaxed">
									"You Ship, We Ship" (YSWS) is how you earn more storage.
								</p>
								<p className="text-lg mb-6 text-text-muted leading-relaxed">
									Instead of paying with money, you pay with code. When you ship
									a project using Silo, you can submit it to us. Based on the
									hours you spent coding, we'll permanently increase your
									storage quota.
								</p>

								{p.yswsQuotaPerHour ? (
									<div className="mt-8 mb-12 border border-white/10 rounded-3xl p-8 bg-hc-darker/50">
										<h3 className="text-text-muted text-sm font-bold uppercase tracking-wider mb-6 text-center">
											Reward Calculator
										</h3>
										<div className="flex flex-col md:flex-row gap-8 items-center">
											<div className="flex-1 w-full">
												<div className="flex justify-between items-end mb-4">
													<label
														className="text-sm font-bold text-white"
														htmlFor="docs-hours"
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
													className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-hc-red hover:accent-red-400 transition-all"
												/>
												<div className="flex justify-between mt-2 text-xs text-text-muted font-mono">
													<span>1h</span>
													<span>100h</span>
												</div>
											</div>

											<div className="hidden md:block w-px h-24 bg-white/10" />

											<div className="flex-1 w-full text-center md:text-left">
												<p className="text-text-muted text-xs font-bold uppercase tracking-wider mb-2">
													You Earn
												</p>
												<div className="flex items-baseline justify-center md:justify-start gap-2">
													<span className="text-5xl font-bold text-white tracking-tighter">
														{finalRewardGb}
													</span>
													<span className="text-xl text-white/40 font-bold">
														GB
													</span>
												</div>
												<div className="flex flex-col gap-1 mt-2">
													<p className="text-xs text-text-muted">
														Permanent storage added to your account
													</p>
													{activeTierBonus > 0 ? (
														<p className="text-xs text-hc-green font-bold">
															+{activeTierBonus}% Bonus Applied!
														</p>
													) : null}
												</div>
											</div>
										</div>
									</div>
								) : null}

								<h3 className="text-2xl font-bold mb-4 text-white">
									How it works
								</h3>
								<ol className="list-decimal list-inside space-y-4 text-text-muted mb-8">
									<li>Build a project that uses Silo for storage.</li>
									<li>
										Go to the{" "}
										<a href="/ysws" className="text-hc-red hover:underline">
											YSWS Dashboard
										</a>
										.
									</li>
									<li>Submit your project details and hours spent.</li>
									<li>
										Once approved, your storage limit is automatically
										increased!
									</li>
								</ol>
							</div>
						) : null}

				{activeSection === "auth" ? (
					<div id="auth" className="section-content active">
								<h1 className="text-4xl font-bold mb-6 text-white">
									Authentication
								</h1>
								<p className="text-lg mb-6 text-text-muted">
									To get your credentials:
								</p>
								<ol className="list-decimal list-inside space-y-4 text-text-muted mb-8">
									<li>
										Log in to the{" "}
										<a href="/" className="text-hc-red hover:underline">
											Dashboard
										</a>
										.
									</li>
									<li>
										Click <strong>Create Bucket</strong>.
									</li>
									<li>Copy your Access Key and Secret Key.</li>
								</ol>
								<div className="bg-yellow-500/10 border border-yellow-500/20 p-4 rounded-lg">
									<p className="text-yellow-200 text-sm">
										<strong>Important:</strong> Your Secret Key is only shown
										once. Make sure to save it securely.
									</p>
								</div>
					</div>
				) : null}

				{activeSection === "custom-domains" ? (
					<div id="custom-domains" className="section-content active">
						<h1 className="text-4xl font-bold mb-6 text-white">
							Custom Domains
						</h1>
						<p className="text-lg mb-6 text-text-muted leading-relaxed">
							Every bucket can publish through your own hostname. This keeps your app portable and lets you repoint DNS to another S3-compatible provider later without changing object URLs.
						</p>
						<div className="rounded-3xl border border-white/10 p-8 bg-hc-darker/50 mb-8">
							<h3 className="text-2xl font-bold mb-4 text-white">Setup flow</h3>
							<ol className="list-decimal list-inside space-y-3 text-text-muted">
								<li>Add a hostname in the bucket custom-domain modal.</li>
								<li>Create a CNAME or ALIAS to <code>silo.deployor.dev</code>.</li>
								<li>Publish the TXT token at <code>_silo-domain-verification.your-domain.com</code>.</li>
								<li>Verify the domain and set it as primary.</li>
								<li>Public URLs and temporary private links will now default to that domain.</li>
							</ol>
						</div>
						<h3 className="text-2xl font-bold mb-4 text-white">Example URLs</h3>
						<CodeBlock
							code={`# Public object URL\nhttps://assets.example.com/images/logo.png\n\n# Temporary private link\nhttps://assets.example.com/private/report.pdf?expires=1742873000000&signature=...`}
						/>
						<p className="text-text-muted">
							When you ever need to leave Silo, migrate the objects to another S3-compatible provider and repoint the same DNS records. Your application URLs stay the same.
						</p>
					</div>
				) : null}

				{activeSection === "public-buckets" ? (
							<div id="public-buckets" className="section-content active">
								<h1 className="text-4xl font-bold mb-6 text-white">
									Public Buckets
								</h1>
								<p className="text-lg mb-6 text-text-muted">
									By default, all buckets are <strong>private</strong>. This
									means every request requires valid authentication signatures.
								</p>
								<p className="text-lg mb-6 text-text-muted">
									You can toggle a bucket to be <strong>Public</strong> in the
									dashboard.
								</p>
								<h3 className="text-2xl font-bold mb-4 text-white">
									What does Public mean?
								</h3>
								<ul className="list-disc list-inside space-y-2 text-text-muted mb-6">
									<li>
										Anyone can perform <code>GetObject</code> and{" "}
										<code>HeadObject</code> requests without authentication.
									</li>
									<li>
										Files are accessible via direct URL:{" "}
										<code>https://silo.deployor.dev/bucket-name/key</code>.
									</li>
									<li>
										<code>ListObjects</code> and other operations still require
										authentication.
									</li>
								</ul>
								<p className="text-text-muted">
									This is okay for hosting static assets like images, CSS, or
									game files that need to be publicly accessible on the web, but
									should be used with alot of caution.
								</p>
							</div>
						) : null}

						{activeSection === "cors" ? (
							<div id="cors" className="section-content active">
								<h1 className="text-4xl font-bold mb-6 text-white">
									CORS Configuration
								</h1>
								<p className="text-lg mb-6 text-text-muted">
									Cross-Origin Resource Sharing (CORS) allows client-side web
									applications loaded in one domain to interact with resources
									in a different domain.
								</p>
								<p className="text-lg mb-6 text-text-muted">
									Silo supports per-bucket CORS configuration. You can manage
									this directly in the <strong>Dashboard</strong> or via the
									standard S3 API.
								</p>
								<h3 className="text-2xl font-bold mb-4 text-white">
									How it works
								</h3>
								<p className="text-text-muted mb-6">
									We handle CORS at the proxy level ("Virtual CORS"). When you
									set a CORS configuration, we store it and intercept{" "}
									<code>OPTIONS</code> requests to respond with the correct
									headers. We also inject the appropriate CORS headers into{" "}
									<code>GET</code> and other responses based on your rules.
								</p>
								<h3 className="text-2xl font-bold mb-4 text-white">
									Example Configuration
								</h3>
								<CodeBlock
									code={`{
  "CORSRules": [
    {
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedOrigins": ["https://myapp.com"],
      "ExposeHeaders": []
    }
  ]
}`}
								/>
							</div>
						) : null}

						{activeSection === "supported-api" ? (
							<div id="supported-api" className="section-content active">
								<h1 className="text-4xl font-bold mb-6 text-white">
									Supported Operations
								</h1>
								<p className="mb-6 text-text-muted">
									Silo implements a subset of the Amazon S3 API. The following
									operations are fully supported:
								</p>
								<div className="space-y-8">
									<div>
										<h3 className="text-xl font-bold mb-3 text-white">
											Bucket Operations
										</h3>
										<ul className="grid grid-cols-1 md:grid-cols-2 gap-2 text-text-muted font-mono text-sm">
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span> ListBuckets{" "}
												<span className="text-xs opacity-50 ml-auto">
													(GET /)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span> HeadBucket{" "}
												<span className="text-xs opacity-50 ml-auto">
													(HEAD /bucket)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span>{" "}
												GetBucketLocation{" "}
												<span className="text-xs opacity-50 ml-auto">
													(GET /bucket?location)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span> PutBucketCors{" "}
												<span className="text-xs opacity-50 ml-auto">
													(PUT /bucket?cors)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span> GetBucketCors{" "}
												<span className="text-xs opacity-50 ml-auto">
													(GET /bucket?cors)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span>{" "}
												DeleteBucketCors{" "}
												<span className="text-xs opacity-50 ml-auto">
													(DELETE /bucket?cors)
												</span>
											</li>
										</ul>
									</div>

									<div>
										<h3 className="text-xl font-bold mb-3 text-white">
											Object Operations
										</h3>
										<ul className="grid grid-cols-1 md:grid-cols-2 gap-2 text-text-muted font-mono text-sm">
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span> PutObject{" "}
												<span className="text-xs opacity-50 ml-auto">
													(PUT /bucket/key)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span> GetObject{" "}
												<span className="text-xs opacity-50 ml-auto">
													(GET /bucket/key)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span> HeadObject{" "}
												<span className="text-xs opacity-50 ml-auto">
													(HEAD /bucket/key)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span> DeleteObject{" "}
												<span className="text-xs opacity-50 ml-auto">
													(DELETE /bucket/key)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span> CopyObject{" "}
												<span className="text-xs opacity-50 ml-auto">
													(PUT /bucket/key + x-amz-copy-source)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span> ListObjectsV2{" "}
												<span className="text-xs opacity-50 ml-auto">
													(GET /bucket?list-type=2)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span> DeleteObjects{" "}
												<span className="text-xs opacity-50 ml-auto">
													(POST /bucket?delete)
												</span>
											</li>
										</ul>
									</div>

									<div>
										<h3 className="text-xl font-bold mb-3 text-white">
											Multipart Uploads
										</h3>
										<p className="text-sm text-text-muted mb-3">
											Full support for large files.
										</p>
										<ul className="grid grid-cols-1 md:grid-cols-2 gap-2 text-text-muted font-mono text-sm">
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span>{" "}
												CreateMultipartUpload{" "}
												<span className="text-xs opacity-50 ml-auto">
													(POST /bucket/key?uploads)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span> UploadPart{" "}
												<span className="text-xs opacity-50 ml-auto">
													(PUT /bucket/key?partNumber&uploadId)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span>{" "}
												CompleteMultipartUpload{" "}
												<span className="text-xs opacity-50 ml-auto">
													(POST /bucket/key?uploadId)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span>{" "}
												AbortMultipartUpload{" "}
												<span className="text-xs opacity-50 ml-auto">
													(DELETE /bucket/key?uploadId)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span>{" "}
												ListMultipartUploads{" "}
												<span className="text-xs opacity-50 ml-auto">
													(GET /bucket?uploads)
												</span>
											</li>
											<li className="flex items-center gap-2">
												<span className="text-green-400">✓</span> ListParts{" "}
												<span className="text-xs opacity-50 ml-auto">
													(GET /bucket/key?uploadId)
												</span>
											</li>
										</ul>
									</div>

									<div className="mt-8">
										<details className="group bg-hc-darker rounded-xl border border-white/5 overflow-hidden">
											<summary className="flex items-center justify-between p-4 cursor-pointer hover:bg-white/5 transition-colors">
												<h3 className="text-xl font-bold text-white">
													Unsupported Operations
												</h3>
												<span className="text-text-muted group-open:rotate-180 transition-transform">
													<PhIcon className="ph ph-caret-down text-xl" />
												</span>
											</summary>
											<div className="p-6 border-t border-white/5 space-y-8">
												<p className="text-sm text-text-muted">
													The following operations are{" "}
													<strong>not supported</strong>.
												</p>

												<div className="flex gap-4 mb-6 text-xs font-mono">
													<div className="flex items-center gap-2">
														<span className="w-3 h-3 rounded bg-white/5 border border-white/10" />
														<span className="text-text-muted">
															Dead / Deprecated by AWS
														</span>
													</div>
													<div className="flex items-center gap-2">
														<span className="w-3 h-3 rounded bg-red-500/10 border border-red-500/20" />
														<span className="text-text-muted">
															Not Implemented in Silo
														</span>
													</div>
												</div>

												<div>
													<h4 className="font-bold text-white mb-2 uppercase tracking-wider text-xs">
														Dead / Deprecated by AWS
													</h4>
													<p className="text-xs text-text-muted mb-3 italic">
														These features are deprecated, discontinued, or
														discouraged by S3.
													</p>
													<div className="flex flex-wrap gap-2 font-mono text-xs">
														<span
															className="bg-white/5 px-2 py-1 rounded border border-white/10 text-text-muted"
															title="REST API. (SOAP was officially deactivated on Oct 30, 2025)."
														>
															SOAP over HTTP/HTTPS
														</span>
														<span
															className="bg-white/5 px-2 py-1 rounded border border-white/10 text-text-muted"
															title="Signature Version 4 (SigV4) or SigV4A."
														>
															Signature Version 2 (SigV2)
														</span>
														<span
															className="bg-white/5 px-2 py-1 rounded border border-white/10 text-text-muted"
															title="Amazon Athena or S3 Object Lambda. (Closed to new customers as of July 2024)."
														>
															SelectObjectContent (S3 Select)
														</span>
														<span
															className="bg-white/5 px-2 py-1 rounded border border-white/10 text-text-muted"
															title="Amazon CloudFront. BitTorrent support is completely non-functional."
														>
															GetObjectTorrent
														</span>
														<span
															className="bg-white/5 px-2 py-1 rounded border border-white/10 text-text-muted"
															title="PutBucketLifecycleConfiguration. Old version is prefix-only."
														>
															PutBucketLifecycle
														</span>
														<span
															className="bg-white/5 px-2 py-1 rounded border border-white/10 text-text-muted"
															title="PutBucketReplicationConfiguration. (Legacy V1 replication lacks modern filters)."
														>
															PutBucketReplication
														</span>
														<span
															className="bg-white/5 px-2 py-1 rounded border border-white/10 text-text-muted"
															title="PutBucketNotificationConfiguration. (Old call cannot target Lambda/SQS correctly)."
														>
															PutBucketNotification
														</span>
														<span
															className="bg-white/5 px-2 py-1 rounded border border-white/10 text-text-muted"
															title="Bucket Policies. Set Object Ownership to BucketOwnerEnforced."
														>
															ACLs (Access Control Lists)
														</span>
														<span
															className="bg-white/5 px-2 py-1 rounded border border-white/10 text-text-muted"
															title="Standard-IA or Intelligent-Tiering. (RRS is now a 'zombie' class)."
														>
															REDUCED_REDUNDANCY
														</span>
														<span
															className="bg-white/5 px-2 py-1 rounded border border-white/10 text-text-muted"
															title="ListObjectsV2. V1 has significant performance lag during pagination."
														>
															ListObjects (V1)
														</span>
													</div>
												</div>

												<div>
													<h4 className="font-bold text-white mb-2 uppercase tracking-wider text-xs">
														Not Implemented in Silo
													</h4>
													<p className="text-xs text-text-muted mb-3 italic">
														These are valid S3 features that are not currently
														supported by Silo's infrastructure.
													</p>
													<div className="flex flex-wrap gap-2 font-mono text-xs">
														<span className="bg-red-500/10 px-2 py-1 rounded border border-red-500/20 text-red-400">
															Versioning
														</span>
														<span className="bg-red-500/10 px-2 py-1 rounded border border-red-500/20 text-red-400">
															Encryption
														</span>
														<span className="bg-red-500/10 px-2 py-1 rounded border border-red-500/20 text-red-400">
															Object Locking
														</span>
														<span className="bg-red-500/10 px-2 py-1 rounded border border-red-500/20 text-red-400">
															Website Hosting
														</span>
														<span className="bg-red-500/10 px-2 py-1 rounded border border-red-500/20 text-red-400">
															Accelerate
														</span>
														<span className="bg-red-500/10 px-2 py-1 rounded border border-red-500/20 text-red-400">
															Tagging
														</span>
														<span className="bg-red-500/10 px-2 py-1 rounded border border-red-500/20 text-red-400">
															Bucket Policies
														</span>
														<span className="bg-red-500/10 px-2 py-1 rounded border border-red-500/20 text-red-400">
															Public Access Blocks
														</span>
														<span className="bg-red-500/10 px-2 py-1 rounded border border-red-500/20 text-red-400">
															Ownership Controls
														</span>
													</div>
												</div>
											</div>
										</details>
									</div>
								</div>
							</div>
						) : null}

						{activeSection === "endpoints" ? (
							<div id="endpoints" className="section-content active">
								<h1 className="text-4xl font-bold mb-6 text-white">
									Endpoints & Regions
								</h1>
								<div className="space-y-6">
									<div>
										<h3 className="text-lg font-bold text-white mb-2">
											Region
										</h3>
										<code className="text-hc-red">eu-central-1</code>
									</div>
									<div>
										<h3 className="text-lg font-bold text-white mb-2">
											Endpoint URL
										</h3>
										<code className="text-hc-blue">
											https://silo.deployor.dev
										</code>
									</div>
									<div>
										<h3 className="text-lg font-bold text-white mb-2">
											Addressing Styles
										</h3>
										<p className="text-text-muted mb-4">
											For authenticated API requests, you can simply use the
											root endpoint. Your Access Key is uniquely tied to a
											specific bucket, so we automatically route your requests
											to the correct bucket.
										</p>
										<div className="bg-hc-darker p-4 rounded-lg border border-white/10 space-y-2 font-mono text-sm mb-6">
											<div className="flex flex-col gap-1">
												<span className="text-text-muted">
													{"// API Endpoint (Authenticated)"}
												</span>
												<span className="text-white">
													https://silo.deployor.dev
												</span>
												<span className="text-xs text-text-muted mt-1">
													No bucket name needed in hostname or path for API
													calls.
												</span>
											</div>
										</div>
										<p className="text-text-muted mb-2">
											For <strong>Public Buckets</strong> (direct file access in
											browser), you should use virtual-hosted-style or
											path-style URLs:
										</p>
										<div className="bg-hc-darker p-4 rounded-lg border border-white/10 space-y-2 font-mono text-sm">
											<div className="flex flex-col gap-1">
												<span className="text-text-muted">
													{"// Virtual Host (Public Access)"}
												</span>
												<span className="text-white">
													https://
													<span className="text-hc-blue">{"{bucket}"}</span>
													.silo.deployor.dev/
													<span className="text-green-400">{"{key}"}</span>
												</span>
											</div>
											<div className="flex flex-col gap-1 mt-4">
												<span className="text-text-muted">
													{"// Path Style (Public Access)"}
												</span>
												<span className="text-white">
													https://silo.deployor.dev/
													<span className="text-hc-blue">{"{bucket}"}</span>/
													<span className="text-green-400">{"{key}"}</span>
												</span>
											</div>
										</div>
									</div>
								</div>
							</div>
						) : null}

						{activeSection === "limits" ? (
							<div id="limits" className="section-content active">
								<h1 className="text-4xl font-bold mb-6 text-white">
									Limits & Quotas
								</h1>
								<div className="space-y-6">
									<div>
										<h3 className="text-xl font-bold text-white mb-2">
											Storage & Bandwidth
										</h3>
										<p className="text-text-muted mb-4">
											We monitor storage usage and egress bandwidth.
										</p>
										<ul className="list-disc list-inside space-y-2 text-text-muted">
											<li>
												<strong>Storage Limit:</strong> Defined per user (check
												dashboard).
											</li>
											<li>
												<strong>Egress Limit:</strong> Typically 3x your storage
												limit.
											</li>
										</ul>
									</div>
								</div>
							</div>
						) : null}

						{activeSection === "aws-cli" ? (
							<div id="aws-cli" className="section-content active">
								<h1 className="text-4xl font-bold mb-6 text-white">AWS CLI</h1>
								<p className="mb-6 text-text-muted">
									You can use the standard AWS CLI to interact with Silo.
									Configure a profile with your keys and our endpoint.
								</p>
								<h3 className="text-lg font-bold text-white mb-3">
									Configuration
								</h3>
								<CodeBlock
									code={`aws configure --profile silo
# AWS Access Key ID: [Your Access Key]
# AWS Secret Access Key: [Your Secret Key]
# Default region name: eu-central-1
# Default output format: json`}
								/>
								<h3 className="text-lg font-bold text-white mb-3">
									Usage Examples
								</h3>
								<CodeBlock
									code={`# List Buckets
aws s3 ls --endpoint-url https://silo.deployor.dev --profile silo

# Upload a file
aws s3 cp myfile.txt s3://my-bucket/myfile.txt --endpoint-url https://silo.deployor.dev --profile silo

# List Objects
aws s3 ls s3://my-bucket --endpoint-url https://silo.deployor.dev --profile silo`}
								/>
							</div>
						) : null}

						{activeSection === "js" ? (
							<div id="js" className="section-content active">
								<h1 className="text-4xl font-bold mb-6 text-white">
									JavaScript / TypeScript
								</h1>
								<p className="mb-6 text-text-muted">
									The best way to interact with Silo in JavaScript/TypeScript is
									using the official AWS SDK v3.
								</p>
								<div className="bg-hc-blue/10 border border-hc-blue/20 p-4 rounded-lg mb-8">
									<h4 className="text-hc-blue font-bold mb-2">Quick Start</h4>
									<p className="text-sm text-text-muted">
										Don't want to read? Copy the initialization code and start
										shipping.
									</p>
								</div>
								<h3 className="text-lg font-bold text-white mb-3">
									1. Installation
								</h3>
								<CodeBlock
									code={`npm install @aws-sdk/client-s3
# or
bun add @aws-sdk/client-s3`}
								/>
								<h3 className="text-lg font-bold text-white mb-3">
									2. Initialization
								</h3>
								<p className="text-text-muted mb-3">
									Create a reusable client instance. We recommend storing your
									keys in a <code>.env</code> file.
								</p>
								<CodeBlock
									code={`import { S3Client } from "@aws-sdk/client-s3";

// Initialize the client
const s3 = new S3Client({
  region: "auto",
  endpoint: "https://silo.deployor.dev",
  credentials: {
    accessKeyId: process.env.ACCESS_KEY_ID,     // e.g. "23823..."
    secretAccessKey: process.env.SECRET_ACCESS_KEY, // e.g. "82382..."
  },
});`}
								/>
								<h3 className="text-lg font-bold text-white mb-3">
									3. Uploading Files (PutObject)
								</h3>
								<p className="text-text-muted mb-3">
									You can upload strings, Buffers, or Streams. Always set the{" "}
									<code>ContentType</code> so browsers know how to handle the
									file.
								</p>
								<CodeBlock
									code={`import { PutObjectCommand } from "@aws-sdk/client-s3";
import { readFile } from "fs/promises";

// Example 1: Uploading a simple text string
await s3.send(new PutObjectCommand({
  Bucket: "my-bucket",
  Key: "hello.txt",
  Body: "Hello World!",
  ContentType: "text/plain"
}));

// Example 2: Uploading an image from disk
const fileBuffer = await readFile("./image.png");
await s3.send(new PutObjectCommand({
  Bucket: "my-bucket",
  Key: "images/profile.png",
  Body: fileBuffer,
  ContentType: "image/png"
}));`}
								/>
								<h3 className="text-lg font-bold text-white mb-3">
									4. Downloading Files (GetObject)
								</h3>
								<p className="text-text-muted mb-3">
									Reading files returns a stream. Here's a helper to convert it
									to a string.
								</p>
								<CodeBlock
									code={`import { GetObjectCommand } from "@aws-sdk/client-s3";

const response = await s3.send(new GetObjectCommand({
  Bucket: "my-bucket",
  Key: "hello.txt"
}));

// Helper to convert stream to string
const str = await response.Body.transformToString();
console.log(str); // "Hello World!"`}
								/>
								<h3 className="text-lg font-bold text-white mb-3">
									5. Listing Files
								</h3>
								<p className="text-text-muted mb-3">
									List contents of a bucket. Useful for building file browsers.
								</p>
								<CodeBlock
									code={`import { ListObjectsV2Command } from "@aws-sdk/client-s3";

const response = await s3.send(new ListObjectsV2Command({
  Bucket: "my-bucket",
  Prefix: "images/" // Optional: filter by folder
}));

// Check if bucket is empty
if (!response.Contents) {
  console.log("Bucket is empty!");
} else {
  response.Contents.forEach((file) => {
    console.log(file.Key + " (" + file.Size + " bytes)");
  });
}`}
								/>
								<h3 className="text-lg font-bold text-white mb-3">
									6. Deleting Files
								</h3>
								<CodeBlock
									code={`import { DeleteObjectCommand } from "@aws-sdk/client-s3";

await s3.send(new DeleteObjectCommand({
  Bucket: "my-bucket",
  Key: "hello.txt"
}));`}
								/>
								<h3 className="text-lg font-bold text-white mb-3">
									7. Generating Presigned URLs
								</h3>
								<p className="text-text-muted mb-3">
									Want to let users upload directly to your bucket without
									sharing your secret key? Use Presigned URLs.
								</p>
								<CodeBlock
									code={`import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PutObjectCommand } from "@aws-sdk/client-s3";

const command = new PutObjectCommand({
  Bucket: "my-bucket",
  Key: "user-upload.png",
});

// Generate a URL valid for 15 minutes
const url = await getSignedUrl(s3, command, { expiresIn: 900 });
console.log("Upload here:", url);`}
								/>
							</div>
						) : null}

						{activeSection === "python" ? (
							<div id="python" className="section-content active">
								<h1 className="text-4xl font-bold mb-6 text-white">
									Python (Boto3)
								</h1>
								<p className="mb-6 text-text-muted">
									Boto3 is the standard AWS SDK for Python. It's robust and
									widely used in data science and backend development.
								</p>
								<h3 className="text-lg font-bold text-white mb-3">
									1. Installation
								</h3>
								<CodeBlock code={`pip install boto3`} />
								<h3 className="text-lg font-bold text-white mb-3">
									2. Initialization
								</h3>
								<CodeBlock
									code={`import boto3
import os

# Initialize the S3 client
s3 = boto3.client('s3',
    endpoint_url='https://silo.deployor.dev',
    aws_access_key_id=os.getenv('ACCESS_KEY'),
    aws_secret_access_key=os.getenv('SECRET_KEY'),
    region_name='auto'
)`}
								/>
								<h3 className="text-lg font-bold text-white mb-3">
									3. Uploading Files
								</h3>
								<CodeBlock
									code={`# Upload a file from disk
s3.upload_file('local_image.jpg', 'my-bucket', 'images/remote_image.jpg')

# Upload a file object (useful for web frameworks like Flask/Django)
with open('local_image.jpg', 'rb') as f:
    s3.upload_fileobj(f, 'my-bucket', 'images/remote_image.jpg')

# Upload raw bytes
s3.put_object(
    Bucket='my-bucket',
    Key='hello.txt',
    Body=b'Hello World!',
    ContentType='text/plain'
)`}
								/>
								<h3 className="text-lg font-bold text-white mb-3">
									4. Downloading Files
								</h3>
								<CodeBlock
									code={`# Download to disk
s3.download_file('my-bucket', 'images/remote_image.jpg', 'local_image.jpg')

# Download to memory
response = s3.get_object(Bucket='my-bucket', Key='hello.txt')
content = response['Body'].read().decode('utf-8')
print(content)`}
								/>
								<h3 className="text-lg font-bold text-white mb-3">
									5. Listing Objects
								</h3>
								<CodeBlock
									code={`paginator = s3.get_paginator('list_objects_v2')
for page in paginator.paginate(Bucket='my-bucket'):
    for obj in page.get('Contents', []):
        print(f"{obj['Key']} - {obj['Size']} bytes")`}
								/>
							</div>
						) : null}

						{activeSection === "go" ? (
							<div id="go" className="section-content active">
								<h1 className="text-4xl font-bold mb-6 text-white">Go</h1>
								<p className="mb-6 text-text-muted">
									Use the official AWS SDK for Go v2. It provides a type-safe
									and performant way to interact with Silo.
								</p>
								<h3 className="text-lg font-bold text-white mb-3">
									1. Installation
								</h3>
								<CodeBlock
									code={`go get github.com/aws/aws-sdk-go-v2
go get github.com/aws/aws-sdk-go-v2/config
go get github.com/aws/aws-sdk-go-v2/service/s3`}
								/>
								<h3 className="text-lg font-bold text-white mb-3">
									2. Complete Example
								</h3>
								<CodeBlock
									code={`package main

import (
 "context"
 "fmt"
 "log"
 "os"
 "strings"

 "github.com/aws/aws-sdk-go-v2/aws"
 "github.com/aws/aws-sdk-go-v2/config"
 "github.com/aws/aws-sdk-go-v2/credentials"
 "github.com/aws/aws-sdk-go-v2/service/s3"
)

func main() {
    // 1. Configure the custom endpoint resolver
 r2Resolver := aws.EndpointResolverWithOptionsFunc(func(service, region string, options ...interface{}) (aws.Endpoint, error) {
  return aws.Endpoint{
   URL: "https://silo.deployor.dev",
  }, nil
 })

    // 2. Load credentials
 cfg, err := config.LoadDefaultConfig(context.TODO(),
  config.WithEndpointResolverWithOptions(r2Resolver),
  config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
            os.Getenv("ACCESS_KEY"),
            os.Getenv("SECRET_KEY"),
            "",
        )),
        config.WithRegion("auto"),
 )
 if err != nil {
  log.Fatal(err)
 }

 client := s3.NewFromConfig(cfg)

    // 3. Upload a file
 _, err = client.PutObject(context.TODO(), &s3.PutObjectInput{
  Bucket: aws.String("my-bucket"),
  Key:    aws.String("hello.txt"),
  Body:   strings.NewReader("Hello World!"),
        ContentType: aws.String("text/plain"),
 })
 if err != nil {
  log.Fatal(err)
 }
 fmt.Println("Uploaded hello.txt")

    // 4. List files
     output, err := client.ListObjectsV2(context.TODO(), &s3.ListObjectsV2Input{
         Bucket: aws.String("my-bucket"),
     })
     if err != nil {
         log.Fatal(err)
     }

     for _, object := range output.Contents {
         fmt.Printf("Found: %s (%d bytes)\\n", *object.Key, object.Size)
     }
}`}
								/>
							</div>
						) : null}

						{activeSection === "rclone" ? (
							<div id="rclone" className="section-content active">
								<h1 className="text-4xl font-bold mb-6 text-white">Rclone</h1>
								<p className="mb-6 text-text-muted">
									Rclone is the "Swiss army knife of cloud storage". It's
									perfect for backups, migrations, and mounting buckets as local
									drives.
								</p>
								<h3 className="text-lg font-bold text-white mb-3">
									1. Interactive Configuration
								</h3>
								<p className="text-text-muted mb-3">
									Run <code>rclone config</code> and follow these steps:
								</p>
								<ol className="list-decimal list-inside space-y-2 text-text-muted mb-6 font-mono text-sm bg-black/20 p-4 rounded-lg">
									<li>
										<span className="text-hc-blue">n</span> (New remote)
									</li>
									<li>
										name: <span className="text-hc-blue">silo</span>
									</li>
									<li>
										Storage: <span className="text-hc-blue">s3</span>
									</li>
									<li>
										Provider: <span className="text-hc-blue">Other</span>
									</li>
									<li>
										env_auth: <span className="text-hc-blue">false</span>
									</li>
									<li>
										access_key_id:{" "}
										<span className="text-hc-blue">
											[Paste your Access Key]
										</span>
									</li>
									<li>
										secret_access_key:{" "}
										<span className="text-hc-blue">
											[Paste your Secret Key]
										</span>
									</li>
									<li>
										region: <span className="text-hc-blue">auto</span>
									</li>
									<li>
										endpoint:{" "}
										<span className="text-hc-blue">
											https://silo.deployor.dev
										</span>
									</li>
									<li>
										acl: <span className="text-hc-blue">private</span>
									</li>
								</ol>
								<h3 className="text-lg font-bold text-white mb-3">
									2. Manual Configuration
								</h3>
								<p className="text-text-muted mb-3">
									Alternatively, edit <code>~/.config/rclone/rclone.conf</code>{" "}
									directly:
								</p>
								<CodeBlock
									code={`[silo]
type = s3
provider = Other
env_auth = false
access_key_id = YOUR_ACCESS_KEY
secret_access_key = YOUR_SECRET_KEY
endpoint = https://silo.deployor.dev
region = auto
acl = private`}
								/>
								<h3 className="text-lg font-bold text-white mb-3">
									3. Common Commands
								</h3>
								<div className="space-y-4">
									<div>
										<p className="text-white font-bold text-sm mb-1">
											List all buckets
										</p>
										<CodeBlock code={`rclone lsd silo:`} />
									</div>
									<div>
										<p className="text-white font-bold text-sm mb-1">
											Copy a local file to Silo
										</p>
										<CodeBlock
											code={`rclone copy ./my-game.zip silo:games-bucket/v1/`}
										/>
									</div>
									<div>
										<p className="text-white font-bold text-sm mb-1">
											Sync a local folder (mirror)
										</p>
										<CodeBlock
											code={`rclone sync ./build silo:my-website/ --progress`}
										/>
									</div>
									<div>
										<p className="text-white font-bold text-sm mb-1">
											Mount bucket as a local drive (macOS/Linux)
										</p>
										<CodeBlock
											code={`mkdir ~/mnt/silo
rclone mount silo:my-bucket ~/mnt/silo --vfs-cache-mode writes`}
										/>
									</div>
								</div>
							</div>
						) : null}
					</div>
				</main>
			</div>
		</AppShell>
	);
}
