import { useEffect, useRef, useState } from "react";
import { AppShell } from "../components/AppShell";
import { useClipboard } from "../hooks/useClipboard";
import { fetchJson } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type UploadResult =
	| { success: true; name: string; url: string; size: number }
	| { success: false; name: string; error: string };

type StatsResponse = {
	user: {
		storageUsage: number;
		storageLimit: number;
	};
};

export function CdnPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		pageTitle?: string;
	};
	const user = p.user || null;

	const [dragging, setDragging] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [progress, setProgress] = useState(0);
	const [fileCount, setFileCount] = useState(0);
	const [results, setResults] = useState<UploadResult[]>([]);
	const [postToSlack, setPostToSlack] = useState(true);
	const [usage, setUsage] = useState(0);
	const [limit, setLimit] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const { copy, copied } = useClipboard();

	useEffect(() => {
		fetchJson<StatsResponse>("/api/dashboard/stats")
			.then((data) => {
				setUsage(data.user.storageUsage || 0);
				setLimit(data.user.storageLimit || 1);
			})
			.catch(() => {
				// noop
			});

		try {
			const saved = window.localStorage.getItem("silo_cdn_post_slack");
			if (saved !== null) setPostToSlack(saved === "true");
		} catch {
			// noop
		}
	}, []);

	const savePref = (val: boolean) => {
		setPostToSlack(val);
		try {
			window.localStorage.setItem("silo_cdn_post_slack", String(val));
		} catch {
			// noop
		}
	};

	const uploadFiles = async (filesList: FileList | null) => {
		if (!filesList || filesList.length === 0) return;
		const files = Array.from(filesList);
		setUploading(true);
		setFileCount(files.length);
		setProgress(0);

		const nextResults: UploadResult[] = [];
		let done = 0;

		for (const file of files) {
			if (file.size > 1024 * 1024 * 1024) {
				nextResults.push({
					success: false,
					name: file.name,
					error: "File too large (>1GB)",
				});
			} else {
				const form = new FormData();
				form.append("file", file);
				try {
					const res = await fetch(`/api/cdn/upload?skipSlack=${!postToSlack}`, {
						method: "POST",
						body: form,
					});

					if (res.ok) {
						const data = await res.json();
						nextResults.push({
							success: true,
							name: file.name,
							url: data.url,
							size: file.size,
						});
					} else if (res.status === 413) {
						nextResults.push({
							success: false,
							name: file.name,
							error: "File too large",
						});
					} else {
						const msg = await res.text();
						nextResults.push({
							success: false,
							name: file.name,
							error: msg || `Error ${res.status}`,
						});
					}
				} catch {
					nextResults.push({
						success: false,
						name: file.name,
						error: "Network error",
					});
				}
			}
			done += 1;
			setProgress((done / files.length) * 100);
		}

		setResults((prev) => [...nextResults.reverse(), ...prev]);
		setUploading(false);
		setProgress(0);

		if (inputRef.current) inputRef.current.value = "";

		fetchJson<StatsResponse>("/api/dashboard/stats")
			.then((data) => {
				setUsage(data.user.storageUsage || 0);
				setLimit(data.user.storageLimit || 1);
			})
			.catch(() => {
				// noop
			});
	};

	const usagePercent = Math.min((usage / (limit || 1)) * 100, 100);

	return (
		<AppShell
			title={bootstrap.title}
			user={user}
			pageTitle={p.pageTitle}
			config={bootstrap.config}
		>
			<main className="flex-1 flex flex-col items-center justify-center p-6 w-full max-w-5xl mx-auto">
				<div className="text-center mb-12">
					<h1 className="text-5xl md:text-8xl font-black text-white mb-5 tracking-tighter italic">
						CDN
					</h1>
					<p className="text-text-muted text-lg md:text-xl max-w-2xl mx-auto font-medium mb-6">
						Drag and drop any file to upload.
					</p>

					{user?.isAdmin ? (
						<div className="flex flex-col items-center gap-4 mb-6">
							<div className="bg-blue-500/10 border border-blue-500/20 text-blue-300 px-4 py-2 rounded-lg text-sm inline-block max-w-xl">
								<div className="flex items-center gap-2">
									<i className="ph ph-info text-lg" />
									<span>
										Files uploaded here can be automatically posted to the{" "}
										<span className="font-bold text-white">#cdn</span> channel
										on Slack.
									</span>
								</div>
							</div>
							<label className="flex items-center gap-2 group cursor-pointer">
								<div className="relative flex items-center">
									<input
										checked={postToSlack}
										onChange={(e) => savePref(e.target.checked)}
										type="checkbox"
										className="peer sr-only"
									/>
									<div className="w-10 h-6 bg-white/10 peer-checked:bg-hc-green rounded-full transition-colors duration-200 ease-in-out" />
									<div className="absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform duration-200 ease-in-out peer-checked:translate-x-4" />
								</div>
								<span className="text-text-muted text-sm cursor-pointer select-none group-hover:text-white transition-colors font-medium">
									Post uploaded files to #cdn
								</span>
							</label>
						</div>
					) : (
						<div className="bg-blue-500/10 border border-blue-500/20 text-blue-300 px-4 py-2 rounded-lg text-sm mb-6 inline-block max-w-xl">
							<div className="flex items-center gap-2">
								<i className="ph ph-info text-lg" />
								<span>
									Files uploaded here will be automatically posted to the{" "}
									<span className="font-bold text-white">#cdn</span> channel on
									Slack.
								</span>
							</div>
						</div>
					)}

					<div className="inline-flex flex-wrap justify-center items-center gap-3 bg-white/5 px-4 py-2 rounded-full border border-white/10 max-w-full">
						<div className="w-32 h-2 bg-white/10 rounded-full overflow-hidden">
							<div
								className="h-full bg-hc-red rounded-full transition-all duration-500"
								style={{ width: `${usagePercent}%` }}
							/>
						</div>
						<span className="text-xs font-mono text-text-muted break-words">
							{formatBytes(usage)} / {formatBytes(limit)}
						</span>
					</div>
				</div>

				<button
					type="button"
					className={`w-full max-w-3xl aspect-21/9 bg-black/30 border-2 border-dashed rounded-3xl flex flex-col items-center justify-center p-12 cursor-pointer relative overflow-hidden card-shadow transition-all ${dragging ? "border-hc-red bg-hc-red/5 scale-[1.02]" : "border-white/10"}`}
					onDragEnter={(e) => {
						e.preventDefault();
						setDragging(true);
					}}
					onDragOver={(e) => {
						e.preventDefault();
						setDragging(true);
					}}
					onDragLeave={(e) => {
						e.preventDefault();
						setDragging(false);
					}}
					onDrop={(e) => {
						e.preventDefault();
						setDragging(false);
						uploadFiles(e.dataTransfer.files);
					}}
					onClick={() => inputRef.current?.click()}
				>
					<input
						ref={inputRef}
						type="file"
						className="hidden"
						multiple
						onChange={(e) => uploadFiles(e.target.files)}
					/>

					{!uploading ? (
						<div className="text-center pointer-events-none">
							<div className="inline-flex mb-6 text-hc-red">
								<i className="ph ph-cloud-arrow-up text-5xl" />
							</div>
							<h3 className="text-xl md:text-2xl font-bold text-white mb-2">
								Drop files here
							</h3>
							<p className="text-text-muted font-mono text-sm">
								or click to browse
							</p>
							<p className="text-white/20 font-mono text-xs mt-4">
								Max 1GB per file
							</p>
						</div>
					) : (
						<div className="flex flex-col items-center w-full max-w-md z-20 pointer-events-none">
							<div className="w-full bg-white/10 rounded-full h-3 mb-6 overflow-hidden backdrop-blur-sm">
								<div
									className="bg-hc-red h-3 rounded-full transition-all duration-100"
									style={{ width: `${progress}%` }}
								/>
							</div>
							<p className="text-white font-mono text-base md:text-lg flex items-center gap-2 text-center">
								<i className="ph ph-spinner animate-spin text-xl text-hc-red" />
								<span>
									Uploading{" "}
									<span className="font-bold text-hc-red">{fileCount}</span>{" "}
									files...
								</span>
							</p>
						</div>
					)}
				</button>

				{results.length ? (
					<div className="w-full max-w-3xl mt-12">
						<div className="flex items-center justify-between mb-6">
							<h3 className="text-sm font-bold text-text-muted uppercase tracking-wider">
								Recent Uploads
							</h3>
							<button
								type="button"
								onClick={() => setResults([])}
								className="text-xs text-text-muted hover:text-white transition-colors"
							>
								Clear All
							</button>
						</div>

						<div className="space-y-4">
							{results.map((res) =>
								res.success ? (
									<div
										key={res.url}
										className="bg-hc-dark border border-white/10 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 card-shadow"
									>
										<div className="flex items-center gap-4 overflow-hidden">
											<div className="bg-emerald-500/10 p-3 rounded-xl text-emerald-400 shrink-0 border border-emerald-500/20">
												<i className="ph ph-check text-2xl" />
											</div>
											<div className="min-w-0">
												<p className="text-white font-bold truncate text-base">
													{res.name}
												</p>
												<div className="flex items-center gap-2 text-xs">
													<span className="text-text-muted font-mono">
														{formatBytes(res.size)}
													</span>
													<span className="text-white/20">•</span>
													<a
														href={res.url}
														target="_blank"
														rel="noreferrer"
														className="text-hc-red hover:text-red-400 truncate hover:underline font-mono"
													>
														{res.url}
													</a>
												</div>
											</div>
										</div>
										<div className="flex items-center gap-2">
											<button
												type="button"
												onClick={() => copy(res.url, res.url)}
												className="text-text-muted hover:text-white p-2 rounded-lg"
												title="Copy URL"
											>
												<i
													className={`ph ${copied === res.url ? "ph-check text-emerald-400" : "ph-copy"} text-xl`}
												/>
											</button>
											<a
												href={res.url}
												target="_blank"
												rel="noreferrer"
												className="text-text-muted hover:text-white p-2 rounded-lg"
												title="Open"
											>
												<i className="ph ph-arrow-square-out text-xl" />
											</a>
										</div>
									</div>
								) : (
									<div
										key={`error:${res.name}:${res.error}`}
										className="bg-hc-dark border border-white/10 rounded-2xl p-5 flex items-center gap-4 card-shadow"
									>
										<div className="bg-red-500/10 p-3 rounded-xl text-red-400 shrink-0 border border-red-500/20">
											<i className="ph ph-warning-circle text-2xl" />
										</div>
										<div className="min-w-0">
											<p className="text-white font-bold truncate text-base">
												{res.name}
											</p>
											<p className="text-red-400 text-sm truncate font-mono">
												{res.error}
											</p>
										</div>
									</div>
								),
							)}
						</div>
					</div>
				) : null}
			</main>
		</AppShell>
	);
}
