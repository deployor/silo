import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../components/AppShell";
import { Modal } from "../components/ui/Modal";
import { fetchJson, fetchText } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type FileItem = {
	key: string;
	name: string;
	size: number;
	lastModified: string;
	url: string;
};

type FolderItem = {
	prefix: string;
	name: string;
};

type FilesResponse = {
	files: FileItem[];
	folders: FolderItem[];
	nextContinuationToken?: string;
};

const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif"];
const VIDEO_EXTS = ["mp4", "webm", "ogg", "mov"];
const AUDIO_EXTS = ["mp3", "wav", "aac", "m4a", "flac"];
const TEXT_EXTS = [
	"txt",
	"md",
	"json",
	"js",
	"css",
	"html",
	"xml",
	"csv",
	"ts",
	"tsx",
	"sql",
	"yml",
	"yaml",
	"log",
];

export function FilesPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		bucketName: string;
		breadcrumbs?: string;
	};

	const bucketName = p.bucketName;
	const [search, setSearch] = useState("");
	const [currentPrefix, setCurrentPrefix] = useState("");
	const [files, setFiles] = useState<FileItem[]>([]);
	const [folders, setFolders] = useState<FolderItem[]>([]);
	const [nextToken, setNextToken] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);

	const [previewOpen, setPreviewOpen] = useState(false);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [previewKey, setPreviewKey] = useState("");
	const [previewUrl, setPreviewUrl] = useState("");
	const [previewText, setPreviewText] = useState("");

	const loadFiles = useCallback(
		async (prefix = "", token: string | null = null, reset = true) => {
			setLoading(true);
			setError(null);
			try {
				const q = new URLSearchParams();
				q.set("prefix", prefix);
				if (token) q.set("continuation-token", token);
				const data = await fetchJson<FilesResponse>(
					`/api/dashboard/buckets/${bucketName}/files?${q.toString()}`,
				);
				setCurrentPrefix(prefix);
				setNextToken(data.nextContinuationToken || null);
				if (reset) {
					setFiles(data.files || []);
					setFolders(data.folders || []);
				} else {
					setFiles((prev: FileItem[]) => [...prev, ...(data.files || [])]);
					setFolders((prev: FolderItem[]) => [
						...prev,
						...(data.folders || []),
					]);
				}
			} catch (e) {
				setError(e instanceof Error ? e.message : "Failed to load files");
			} finally {
				setLoading(false);
			}
		},
		[bucketName],
	);

	useEffect(() => {
		loadFiles("", null, true);
	}, [loadFiles]);

	const crumbs = useMemo(() => {
		const parts = currentPrefix.split("/").filter(Boolean);
		let acc = "";
		return [
			{ label: "root", prefix: "" },
			...parts.map((part: string) => {
				acc += `${part}/`;
				return { label: part, prefix: acc };
			}),
		];
	}, [currentPrefix]);

	const handleSearch = () => {
		if (!search.trim()) {
			loadFiles("", null, true);
			return;
		}
		loadFiles(search.trim(), null, true);
	};

	const openPreview = async (file: FileItem) => {
		setPreviewOpen(true);
		setPreviewLoading(true);
		setPreviewError(null);
		setPreviewKey(file.key);
		setPreviewText("");
		try {
			const signed = await fetchJson<{ url: string }>(
				`/api/dashboard/buckets/${bucketName}/files/sign`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ key: file.key }),
				},
			);
			setPreviewUrl(signed.url);

			const ext = file.key.split(".").pop()?.toLowerCase() || "";
			if (TEXT_EXTS.includes(ext)) {
				const text = await fetchText(signed.url);
				setPreviewText(text);
			}
		} catch (e) {
			setPreviewError(
				e instanceof Error ? e.message : "Failed to preview file",
			);
		} finally {
			setPreviewLoading(false);
		}
	};

	const confirmDelete = async () => {
		if (!deleteTarget) return;
		setDeleting(true);
		try {
			await fetchText(
				`/api/dashboard/buckets/${bucketName}/files?key=${encodeURIComponent(deleteTarget)}`,
				{
					method: "DELETE",
				},
			);
			setDeleteTarget(null);
			await loadFiles(currentPrefix, null, true);
		} catch (e) {
			window.alert(e instanceof Error ? e.message : "Delete failed");
		} finally {
			setDeleting(false);
		}
	};

	const previewExt = previewKey.split(".").pop()?.toLowerCase() || "";

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
			breadcrumbs={p.breadcrumbs}
		>
			<div className="max-w-7xl mx-auto w-full">
				<div className="flex justify-between items-center mb-6 gap-4 flex-wrap">
					<h1 className="text-3xl font-bold text-white">File Explorer</h1>
					<div className="flex gap-3">
						<input
							type="text"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleSearch()}
							placeholder="Search files..."
							className="bg-hc-dark border border-white/10 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:border-hc-blue w-64"
						/>
						<button
							type="button"
							onClick={handleSearch}
							className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-xl text-sm font-bold transition-colors"
						>
							Search
						</button>
					</div>
				</div>

				<div className="flex items-center gap-2 text-sm font-mono mb-4 overflow-x-auto whitespace-nowrap pb-2">
					{crumbs.map((c, idx) => (
						<Fragment key={c.prefix || "root"}>
							{idx > 0 ? <span className="text-text-muted">/</span> : null}
							<button
								type="button"
								onClick={() => loadFiles(c.prefix, null, true)}
								className={`hover:text-white ${idx === crumbs.length - 1 ? "text-white font-bold" : "text-text-muted"}`}
							>
								{c.label}
							</button>
						</Fragment>
					))}
				</div>

				<div className="bg-hc-dark rounded-3xl border border-white/10 overflow-hidden card-shadow">
					<div className="overflow-x-auto">
						<table className="w-full text-left text-sm">
							<thead className="bg-white/5 text-text-muted font-bold uppercase text-xs tracking-wider">
								<tr>
									<th className="px-6 py-4 w-10">Type</th>
									<th className="px-6 py-4">Name</th>
									<th className="px-6 py-4">Size</th>
									<th className="px-6 py-4">Last Modified</th>
									<th className="px-6 py-4 text-right">Actions</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-white/5">
								{!loading &&
								!error &&
								files.length === 0 &&
								folders.length === 0 ? (
									<tr>
										<td
											colSpan={5}
											className="px-6 py-8 text-center text-text-muted italic"
										>
											No files found.
										</td>
									</tr>
								) : null}

								{folders.map((folder) => (
									<tr
										key={folder.prefix}
										className="hover:bg-white/5 transition-colors cursor-pointer group"
										onClick={() => loadFiles(folder.prefix, null, true)}
									>
										<td className="px-6 py-4 text-hc-blue">
											<i className="ph-fill ph-folder text-xl" />
										</td>
										<td className="px-6 py-4 font-medium text-white font-mono">
											{folder.name}
										</td>
										<td className="px-6 py-4 text-text-muted">-</td>
										<td className="px-6 py-4 text-text-muted">-</td>
										<td className="px-6 py-4 text-right" />
									</tr>
								))}

								{files.map((file) => (
									<tr
										key={file.key}
										className="hover:bg-white/5 transition-colors group"
									>
										<td className="px-6 py-4 text-text-muted">
											<i className="ph ph-file text-xl" />
										</td>
										<td className="px-6 py-4 font-medium text-white font-mono break-all">
											{file.name}
										</td>
										<td className="px-6 py-4 text-text-muted font-mono text-xs">
											{formatBytes(file.size)}
										</td>
										<td className="px-6 py-4 text-text-muted font-mono text-xs">
											{new Date(file.lastModified).toLocaleString()}
										</td>
										<td className="px-6 py-4 text-right flex justify-end gap-2">
											<button
												type="button"
												onClick={() => openPreview(file)}
												className="text-hc-blue hover:text-blue-400 text-xs font-bold uppercase tracking-wider transition-colors"
											>
												Preview
											</button>
											<button
												type="button"
												onClick={() => setDeleteTarget(file.key)}
												className="text-hc-red hover:text-red-400 text-xs font-bold uppercase tracking-wider opacity-0 group-hover:opacity-100 transition-all"
											>
												Delete
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>

					<div className="p-4 border-t border-white/10 flex justify-center">
						{loading ? (
							<span className="text-text-muted text-sm">Loading...</span>
						) : null}
						{error ? (
							<span className="text-red-400 text-sm">{error}</span>
						) : null}
						{!loading && nextToken ? (
							<button
								type="button"
								onClick={() => loadFiles(currentPrefix, nextToken, false)}
								className="text-text-muted hover:text-white text-sm font-bold py-2 px-4 rounded-lg hover:bg-white/5 transition-colors"
							>
								Load More
							</button>
						) : null}
					</div>
				</div>
			</div>

			<Modal
				open={previewOpen}
				onClose={() => setPreviewOpen(false)}
				className="max-w-4xl p-8"
			>
				<div className="w-full max-h-[75vh] overflow-auto rounded-lg border border-white/10 bg-hc-dark">
					{previewLoading ? (
						<div className="text-text-muted flex items-center justify-center h-64">
							Loading preview...
						</div>
					) : null}
					{!previewLoading && previewError ? (
						<div className="text-hc-red flex items-center justify-center h-64">
							{previewError}
						</div>
					) : null}

					{!previewLoading && !previewError && previewUrl ? (
						IMAGE_EXTS.includes(previewExt) ? (
							<div className="flex items-center justify-center min-h-[200px]">
								<img
									src={previewUrl}
									alt={previewKey.split("/").pop() || "Preview image"}
									className="max-w-full max-h-[70vh] object-contain shadow-lg rounded"
								/>
							</div>
						) : VIDEO_EXTS.includes(previewExt) ? (
							<div className="flex items-center justify-center min-h-[200px]">
								<video
									src={previewUrl}
									controls
									className="max-w-full max-h-[70vh] rounded shadow-lg"
								>
									<track kind="captions" />
								</video>
							</div>
						) : AUDIO_EXTS.includes(previewExt) ? (
							<div className="flex items-center justify-center min-h-[100px] p-4">
								<audio src={previewUrl} controls className="w-full max-w-md">
									<track kind="captions" />
								</audio>
							</div>
						) : TEXT_EXTS.includes(previewExt) ? (
							<pre className="p-4 text-sm font-mono text-white whitespace-pre-wrap break-words">
								{previewText}
							</pre>
						) : (
							<div className="text-center flex flex-col items-center justify-center h-64">
								<i className="ph ph-file-x text-6xl text-text-muted mx-auto mb-4" />
								<p className="text-text-muted">
									Preview not available for this file type.
								</p>
							</div>
						)
					) : null}
				</div>
				<div className="mt-4 text-center flex flex-col gap-2">
					<p className="text-white font-bold text-lg">
						{previewKey.split("/").pop()}
					</p>
					{previewUrl ? (
						<a
							href={previewUrl}
							target="_blank"
							rel="noreferrer"
							className="text-hc-blue hover:underline text-sm"
						>
							Download File
						</a>
					) : null}
				</div>
			</Modal>

			<Modal
				open={!!deleteTarget}
				onClose={() => (deleting ? null : setDeleteTarget(null))}
				title="Delete File"
				className="max-w-md p-8"
			>
				<p className="text-text-muted mb-8 break-all">
					Are you sure you want to delete{" "}
					<span className="text-white">{deleteTarget}</span>? This cannot be
					undone.
				</p>
				<div className="flex justify-end gap-3">
					<button
						type="button"
						onClick={() => setDeleteTarget(null)}
						disabled={deleting}
						className="text-text-muted hover:text-white px-4 py-2 text-sm font-bold transition-colors"
					>
						Cancel
					</button>
					<button
						type="button"
						disabled={deleting}
						onClick={confirmDelete}
						className="bg-hc-red hover:bg-red-600 text-white px-6 py-3 rounded-xl text-sm font-bold transition-all card-shadow flex items-center gap-2"
					>
						{deleting ? <i className="ph ph-spinner animate-spin" /> : null}
						{deleting ? "Deleting..." : "Delete"}
					</button>
				</div>
			</Modal>
		</AppShell>
	);
}
