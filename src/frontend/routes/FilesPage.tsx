import {
	type ChangeEvent,
	Fragment,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { AppShell } from "../components/AppShell";
import { Modal } from "../components/ui/Modal";
import { PhIcon } from "../components/ui/PhIcon";
import { fetchJson, fetchText } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type FileItem = {
	key: string;
	name: string;
	size: number;
	lastModified: string;
	url: string;
	type: "file";
	extension: string;
	parentPrefix: string;
	relativePath: string;
};

type FolderItem = {
	prefix: string;
	name: string;
	type: "folder";
	parentPrefix: string;
};

type DirectoryResponse = {
	mode: "directory";
	currentPrefix: string;
	files: FileItem[];
	folders: FolderItem[];
	nextContinuationToken?: string | null;
};

type SearchResponse = {
	mode: "search";
	query: string;
	scope: "current" | "all";
	currentPrefix: string;
	files: FileItem[];
	folders: FolderItem[];
	nextCursor?: string | null;
	truncated?: boolean;
	scannedPages?: number;
};

type FilesResponse = DirectoryResponse | SearchResponse;

type OperationState = {
	kind: null | "delete" | "rename" | "move" | "upload";
	busy: boolean;
	error: string | null;
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

function normalizePrefix(prefix: string): string {
	const cleaned = prefix.replace(/\\/g, "/").replace(/^\/+/, "");
	if (!cleaned) return "";
	return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

function getParentPrefix(prefix: string): string {
	const cleaned = normalizePrefix(prefix).replace(/\/$/, "");
	if (!cleaned) return "";
	const parts = cleaned.split("/");
	parts.pop();
	return parts.length ? `${parts.join("/")}/` : "";
}

function getFileIcon(file: FileItem): string {
	if (IMAGE_EXTS.includes(file.extension)) return "ph-image";
	if (
		VIDEO_EXTS.includes(file.extension) ||
		AUDIO_EXTS.includes(file.extension)
	) {
		return "ph-file";
	}
	if (TEXT_EXTS.includes(file.extension)) return "ph-file-code";
	return "ph-file";
}

function formatRelativeTime(value: string): string {
	const date = new Date(value);
	return date.toLocaleString();
}

export function FilesPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		bucketName: string;
		breadcrumbs?: string;
	};

	const bucketName = p.bucketName;
	const [search, setSearch] = useState("");
	const [searchScope, setSearchScope] = useState<"current" | "all">("current");
	const [currentPrefix, setCurrentPrefix] = useState("");
	const [files, setFiles] = useState<FileItem[]>([]);
	const [folders, setFolders] = useState<FolderItem[]>([]);
	const [nextToken, setNextToken] = useState<string | null>(null);
	const [searchCursor, setSearchCursor] = useState<string | null>(null);
	const [searchMeta, setSearchMeta] = useState<{
		active: boolean;
		query: string;
		scope: "current" | "all";
		truncated: boolean;
		scannedPages: number;
	}>({
		active: false,
		query: "",
		scope: "current",
		truncated: false,
		scannedPages: 0,
	});
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [operation, setOperation] = useState<OperationState>({
		kind: null,
		busy: false,
		error: null,
	});

	const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
	const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);
	const [deleteTargets, setDeleteTargets] = useState<string[]>([]);
	const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [moveOpen, setMoveOpen] = useState(false);
	const [moveTargetPrefix, setMoveTargetPrefix] = useState("");
	const [uploadOpen, setUploadOpen] = useState(false);
	const [uploadPrefix, setUploadPrefix] = useState("");
	const [uploadMode, setUploadMode] = useState<"files" | "folder">("files");
	const [uploadQueue, setUploadQueue] = useState<File[]>([]);
	const [uploadPaths, setUploadPaths] = useState<Record<string, string>>({});
	const [dragActive, setDragActive] = useState(false);
	const [dragHint, setDragHint] = useState(
		"Drop files to upload into this folder",
	);
	const [previewOpen, setPreviewOpen] = useState(false);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [previewKey, setPreviewKey] = useState("");
	const [previewUrl, setPreviewUrl] = useState("");
	const [previewText, setPreviewText] = useState("");
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const folderInputRef = useRef<HTMLInputElement | null>(null);
	const currentPrefixRef = useRef("");
	const searchMetaRef = useRef(searchMeta);
	const folderInputAttributes = {
		webkitdirectory: "true",
		directory: "true",
	} as unknown as Record<string, string>;

	const activePrefix = currentPrefix;

	useEffect(() => {
		currentPrefixRef.current = currentPrefix;
	}, [currentPrefix]);

	useEffect(() => {
		searchMetaRef.current = searchMeta;
	}, [searchMeta]);

	const loadFiles = useCallback(
		async (options?: {
			prefix?: string;
			token?: string | null;
			reset?: boolean;
			query?: string;
			scope?: "current" | "all";
			cursor?: string | null;
		}) => {
			setLoading(true);
			setError(null);
			try {
				const prefix = normalizePrefix(
					options?.prefix ?? currentPrefixRef.current,
				);
				const reset = options?.reset ?? true;
				const queryValue = (
					options?.query ?? searchMetaRef.current.query
				).trim();
				const scope = options?.scope ?? searchMetaRef.current.scope;
				const params = new URLSearchParams();
				params.set("prefix", prefix);

				if (queryValue) {
					params.set("query", queryValue);
					params.set("scope", scope);
					if (options?.cursor) params.set("cursor", options.cursor);
				} else if (options?.token) {
					params.set("continuation-token", options.token);
				}

				const data = await fetchJson<FilesResponse>(
					`/api/dashboard/buckets/${bucketName}/files?${params.toString()}`,
				);

				setCurrentPrefix(data.currentPrefix);
				setSelectedKeys([]);
				setLastSelectedKey(null);

				if (data.mode === "search") {
					setSearchMeta({
						active: true,
						query: data.query,
						scope: data.scope,
						truncated: Boolean(data.truncated),
						scannedPages: data.scannedPages || 0,
					});
					setSearchCursor(data.nextCursor || null);
					setNextToken(null);
					if (reset) {
						setFiles(data.files || []);
						setFolders([]);
					} else {
						setFiles((prev) => [...prev, ...(data.files || [])]);
					}
					return;
				}

				setSearchMeta({
					active: false,
					query: "",
					scope: scope,
					truncated: false,
					scannedPages: 0,
				});
				setSearchCursor(null);
				setNextToken(data.nextContinuationToken || null);
				if (reset) {
					setFiles(data.files || []);
					setFolders(data.folders || []);
				} else {
					setFiles((prev) => [...prev, ...(data.files || [])]);
					setFolders((prev) => [...prev, ...(data.folders || [])]);
				}
			} catch (cause) {
				setError(
					cause instanceof Error ? cause.message : "Failed to load files",
				);
			} finally {
				setLoading(false);
			}
		},
		[bucketName],
	);

	useEffect(() => {
		loadFiles({ prefix: "", reset: true, query: "" });
	}, [loadFiles]);

	const rows = useMemo(
		() => [
			...folders.map((folder) => ({
				type: "folder" as const,
				id: folder.prefix,
				folder,
			})),
			...files.map((file) => ({ type: "file" as const, id: file.key, file })),
		],
		[files, folders],
	);

	const crumbs = useMemo(() => {
		const parts = activePrefix.split("/").filter(Boolean);
		let acc = "";
		return [
			{ label: "root", prefix: "" },
			...parts.map((part) => {
				acc += `${part}/`;
				return { label: part, prefix: acc };
			}),
		];
	}, [activePrefix]);

	const moveCrumbs = useMemo(() => {
		const normalized = normalizePrefix(moveTargetPrefix);
		const parts = normalized.split("/").filter(Boolean);
		let acc = "";
		return [
			{ label: "root", prefix: "" },
			...parts.map((part) => {
				acc += `${part}/`;
				return { label: part, prefix: acc };
			}),
		];
	}, [moveTargetPrefix]);

	const selectedFiles = useMemo(
		() => files.filter((file) => selectedKeys.includes(file.key)),
		[files, selectedKeys],
	);

	const allVisibleFilesSelected =
		files.length > 0 && selectedFiles.length === files.length;

	const clearOperationError = useCallback(() => {
		setOperation((prev) => ({ ...prev, error: null }));
	}, []);

	const refreshCurrentView = async () => {
		if (searchMeta.active) {
			await loadFiles({
				prefix: currentPrefix,
				query: searchMeta.query,
				scope: searchMeta.scope,
				reset: true,
			});
			return;
		}
		await loadFiles({ prefix: currentPrefix, reset: true, query: "" });
	};

	const handleSearch = async () => {
		if (!search.trim()) {
			await loadFiles({ prefix: currentPrefix, reset: true, query: "" });
			return;
		}
		await loadFiles({
			prefix: currentPrefix,
			query: search.trim(),
			scope: searchScope,
			reset: true,
		});
	};

	const handleRowSelection = (fileKey: string, shiftKey: boolean) => {
		clearOperationError();
		if (!shiftKey || !lastSelectedKey) {
			setSelectedKeys((prev) =>
				prev.includes(fileKey)
					? prev.filter((key) => key !== fileKey)
					: [...prev, fileKey],
			);
			setLastSelectedKey(fileKey);
			return;
		}

		const visibleKeys = files.map((file) => file.key);
		const start = visibleKeys.indexOf(lastSelectedKey);
		const end = visibleKeys.indexOf(fileKey);
		if (start === -1 || end === -1) {
			setSelectedKeys((prev) => [...new Set([...prev, fileKey])]);
			setLastSelectedKey(fileKey);
			return;
		}

		const [from, to] = start < end ? [start, end] : [end, start];
		const keys = visibleKeys.slice(from, to + 1);
		setSelectedKeys((prev) => Array.from(new Set([...prev, ...keys])));
		setLastSelectedKey(fileKey);
	};

	const toggleAllVisibleFiles = () => {
		clearOperationError();
		if (allVisibleFilesSelected) {
			setSelectedKeys([]);
			return;
		}
		setSelectedKeys(files.map((file) => file.key));
	};

	const openPreview = async (file: FileItem) => {
		setPreviewOpen(true);
		setPreviewLoading(true);
		setPreviewError(null);
		setPreviewKey(file.key);
		setPreviewUrl("");
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

			if (TEXT_EXTS.includes(file.extension)) {
				const text = await fetchText(signed.url);
				setPreviewText(text);
			}
		} catch (cause) {
			setPreviewError(
				cause instanceof Error ? cause.message : "Failed to preview file",
			);
		} finally {
			setPreviewLoading(false);
		}
	};

	const startDelete = (keys: string[]) => {
		clearOperationError();
		setDeleteTargets(Array.from(new Set(keys)));
	};

	const confirmDelete = async () => {
		if (deleteTargets.length === 0) return;
		setOperation({ kind: "delete", busy: true, error: null });
		try {
			await fetchJson(`/api/dashboard/buckets/${bucketName}/files`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ keys: deleteTargets }),
			});
			setDeleteTargets([]);
			setSelectedKeys((prev) =>
				prev.filter((key) => !deleteTargets.includes(key)),
			);
			await refreshCurrentView();
			setOperation({ kind: null, busy: false, error: null });
		} catch (cause) {
			setOperation({
				kind: "delete",
				busy: false,
				error: cause instanceof Error ? cause.message : "Delete failed",
			});
		}
	};

	const openRename = (file: FileItem) => {
		clearOperationError();
		setRenameTarget(file);
		setRenameValue(file.name);
	};

	const submitRename = async () => {
		if (!renameTarget) return;
		const trimmed = renameValue.trim();
		if (!trimmed) {
			setOperation({
				kind: "rename",
				busy: false,
				error: "Name cannot be empty",
			});
			return;
		}

		const parentPrefix = renameTarget.parentPrefix;
		const destinationKey = parentPrefix ? `${parentPrefix}${trimmed}` : trimmed;
		setOperation({ kind: "rename", busy: true, error: null });
		try {
			await fetchJson(`/api/dashboard/buckets/${bucketName}/files`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "rename",
					sourceKey: renameTarget.key,
					destinationKey,
				}),
			});
			setRenameTarget(null);
			setRenameValue("");
			await refreshCurrentView();
			setOperation({ kind: null, busy: false, error: null });
		} catch (cause) {
			setOperation({
				kind: "rename",
				busy: false,
				error: cause instanceof Error ? cause.message : "Rename failed",
			});
		}
	};

	const openMove = (keys?: string[]) => {
		const targets = keys && keys.length > 0 ? keys : selectedKeys;
		if (targets.length === 0) return;
		clearOperationError();
		setSelectedKeys(Array.from(new Set(targets)));
		setMoveTargetPrefix(currentPrefix);
		setMoveOpen(true);
	};

	const openUploadModal = (prefix?: string) => {
		clearOperationError();
		setUploadPrefix(prefix ?? currentPrefix);
		setUploadMode("files");
		setUploadQueue([]);
		setUploadPaths({});
		setUploadOpen(true);
	};

	const submitMove = async () => {
		if (selectedKeys.length === 0) return;
		setOperation({ kind: "move", busy: true, error: null });
		try {
			await fetchJson(`/api/dashboard/buckets/${bucketName}/files`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "move",
					sourceKeys: selectedKeys,
					destinationPrefix: normalizePrefix(moveTargetPrefix).replace(
						/\/$/,
						"",
					),
				}),
			});
			setMoveOpen(false);
			await refreshCurrentView();
			setOperation({ kind: null, busy: false, error: null });
		} catch (cause) {
			setOperation({
				kind: "move",
				busy: false,
				error: cause instanceof Error ? cause.message : "Move failed",
			});
		}
	};

	const ingestFiles = useCallback(
		(incoming: FileList | File[]) => {
			const nextFiles = Array.from(incoming);
			if (nextFiles.length === 0) return;
			clearOperationError();
			setUploadPrefix(currentPrefix);
			setUploadOpen(true);
			setUploadQueue(nextFiles);
			setUploadPaths(
				Object.fromEntries(
					nextFiles.map((file) => [
						`${file.name}:${file.size}:${file.lastModified}`,
						file.webkitRelativePath || file.name,
					]),
				),
			);
		},
		[clearOperationError, currentPrefix],
	);

	const onFolderInputChange = (event: ChangeEvent<HTMLInputElement>) => {
		setUploadMode("folder");
		if (event.target.files) ingestFiles(event.target.files);
		event.target.value = "";
	};

	const openSystemPicker = (mode: "files" | "folder") => {
		setUploadMode(mode);
		if (mode === "folder") {
			folderInputRef.current?.click();
			return;
		}
		fileInputRef.current?.click();
	};

	const submitUpload = async () => {
		if (uploadQueue.length === 0) return;
		setOperation({ kind: "upload", busy: true, error: null });
		try {
			const formData = new FormData();
			formData.set("prefix", normalizePrefix(uploadPrefix).replace(/\/$/, ""));
			for (const file of uploadQueue) {
				formData.append("files", file);
				const key = `${file.name}:${file.size}:${file.lastModified}`;
				formData.set(
					`path:${file.name}:${file.size}`,
					uploadPaths[key] || file.name,
				);
			}

			await fetchJson(`/api/dashboard/buckets/${bucketName}/files`, {
				method: "POST",
				body: formData,
			});

			setUploadOpen(false);
			setUploadQueue([]);
			setUploadPaths({});
			await refreshCurrentView();
			setOperation({ kind: null, busy: false, error: null });
		} catch (cause) {
			setOperation({
				kind: "upload",
				busy: false,
				error: cause instanceof Error ? cause.message : "Upload failed",
			});
		}
	};

	const loadMore = async () => {
		if (searchMeta.active) {
			if (!searchCursor) return;
			await loadFiles({
				prefix: currentPrefix,
				query: searchMeta.query,
				scope: searchMeta.scope,
				cursor: searchCursor,
				reset: false,
			});
			return;
		}

		if (!nextToken) return;
		await loadFiles({
			prefix: currentPrefix,
			token: nextToken,
			reset: false,
			query: "",
		});
	};

	const handleDrop = (filesList: FileList | null) => {
		setDragActive(false);
		if (!filesList || filesList.length === 0) return;
		ingestFiles(filesList);
	};

	useEffect(() => {
		const onPaste = (event: ClipboardEvent) => {
			const fileList = event.clipboardData?.files;
			if (fileList && fileList.length > 0) {
				event.preventDefault();
				ingestFiles(fileList);
			}
		};

		window.addEventListener("paste", onPaste);
		return () => window.removeEventListener("paste", onPaste);
	}, [ingestFiles]);

	const previewExt = previewKey.split(".").pop()?.toLowerCase() || "";

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
			breadcrumbs={p.breadcrumbs}
		>
			<div className="max-w-[1400px] mx-auto w-full">
				<div className="bg-hc-dark rounded-[28px] border border-white/10 overflow-hidden card-shadow min-h-[72vh]">
					<div className="px-4 py-3 border-b border-white/10 bg-white/[0.03] flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
						<div className="flex items-center gap-3 min-w-0">
							<div className="h-10 w-10 rounded-2xl bg-hc-red/15 text-hc-red flex items-center justify-center shrink-0">
								<PhIcon className="ph ph-folder-open text-xl" />
							</div>
							<div className="min-w-0">
								<h1 className="text-xl font-bold text-white truncate">
									{bucketName}
								</h1>
								<p className="text-xs text-text-muted font-mono truncate">
									{activePrefix || "root/"}
								</p>
							</div>
						</div>
						<div className="flex flex-wrap gap-2">
							<button
								type="button"
								onClick={() => {
									openUploadModal(currentPrefix);
								}}
								className="bg-hc-red hover:bg-red-500 text-white px-3.5 py-2 rounded-xl text-sm font-bold transition-colors"
							>
								Upload
							</button>
							<button
								type="button"
								disabled={selectedKeys.length === 0}
								onClick={() => openMove()}
								className="bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3.5 py-2 rounded-xl text-sm font-bold transition-colors"
							>
								Move
							</button>
							<button
								type="button"
								disabled={selectedKeys.length === 0}
								onClick={() => startDelete(selectedKeys)}
								className="bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3.5 py-2 rounded-xl text-sm font-bold transition-colors"
							>
								Delete
							</button>
							<input
								ref={fileInputRef}
								type="file"
								multiple
								className="hidden"
								onChange={(event) => {
									if (event.target.files) ingestFiles(event.target.files);
									event.target.value = "";
								}}
							/>
							<input
								ref={folderInputRef}
								type="file"
								multiple
								className="hidden"
								{...folderInputAttributes}
								onChange={onFolderInputChange}
							/>
						</div>
					</div>

					<div className="px-4 py-3 border-b border-white/10 bg-black/10 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
						<div className="flex items-center gap-2 text-sm font-mono overflow-x-auto whitespace-nowrap min-w-0">
							{crumbs.map((crumb, index) => (
								<Fragment key={crumb.prefix || "root"}>
									{index > 0 ? (
										<span className="text-text-muted">/</span>
									) : null}
									<button
										type="button"
										onClick={() =>
											void loadFiles({
												prefix: crumb.prefix,
												reset: true,
												query: "",
											})
										}
										className={
											index === crumbs.length - 1
												? "text-white font-bold"
												: "text-text-muted hover:text-white"
										}
									>
										{crumb.label}
									</button>
								</Fragment>
							))}
						</div>
						<div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:min-w-[520px]">
							<div className="flex-1 flex flex-col gap-3 sm:flex-row">
								<input
									type="text"
									value={search}
									onChange={(event) => setSearch(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") void handleSearch();
									}}
									placeholder={
										searchScope === "current"
											? "Search inside this folder"
											: "Search entire bucket"
									}
									className="bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-hc-blue flex-1"
								/>
								<div className="inline-flex rounded-xl border border-white/10 overflow-hidden bg-black/20">
									<button
										type="button"
										onClick={() => setSearchScope("current")}
										className={`px-4 py-3 text-sm font-bold transition-colors ${searchScope === "current" ? "bg-hc-blue text-white" : "text-text-muted hover:text-white"}`}
									>
										This folder
									</button>
									<button
										type="button"
										onClick={() => setSearchScope("all")}
										className={`px-4 py-3 text-sm font-bold transition-colors ${searchScope === "all" ? "bg-hc-blue text-white" : "text-text-muted hover:text-white"}`}
									>
										Everywhere
									</button>
								</div>
							</div>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={() => void handleSearch()}
									className="bg-white/10 hover:bg-white/20 text-white px-4 py-3 rounded-xl text-sm font-bold transition-colors"
								>
									Search
								</button>
								{searchMeta.active ? (
									<button
										type="button"
										onClick={() => {
											setSearch("");
											void loadFiles({
												prefix: currentPrefix,
												reset: true,
												query: "",
											});
										}}
										className="text-text-muted hover:text-white px-4 py-3 rounded-xl text-sm font-bold transition-colors"
									>
										Clear
									</button>
								) : null}
							</div>
						</div>
					</div>

					{searchMeta.active ? (
						<div className="px-4 py-2 border-b border-white/10 bg-amber-500/5 text-xs text-text-muted flex flex-wrap gap-x-4 gap-y-1">
							<span>
								Results for{" "}
								<span className="text-white">{searchMeta.query}</span>
							</span>
							<span>
								{searchMeta.scope === "current" ? "This folder" : "Everywhere"}
							</span>
							{searchMeta.truncated ? (
								<span className="text-amber-300">
									Refine search for deeper results
								</span>
							) : null}
						</div>
					) : null}

					<section
						className={`bg-hc-dark rounded-3xl border overflow-hidden card-shadow transition-colors ${dragActive ? "border-hc-red" : "border-white/10"}`}
						aria-label="Explorer file table"
						onDragEnter={(event) => {
							event.preventDefault();
							setDragActive(true);
							setDragHint(`Drop files into ${activePrefix || "root"}`);
						}}
						onDragOver={(event) => {
							event.preventDefault();
							setDragActive(true);
						}}
						onDragLeave={(event) => {
							event.preventDefault();
							setDragActive(false);
						}}
						onDrop={(event) => {
							event.preventDefault();
							handleDrop(event.dataTransfer.files);
						}}
					>
						<div className="px-4 py-2.5 border-b border-white/10 flex flex-wrap items-center gap-3 bg-white/[0.03]">
							<label className="inline-flex items-center gap-2 text-xs font-medium text-text-muted">
								<input
									type="checkbox"
									checked={allVisibleFilesSelected}
									onChange={toggleAllVisibleFiles}
									className="rounded border-white/10 bg-black/30"
								/>
								Select visible
							</label>
							<span className="text-xs text-text-muted">
								{selectedKeys.length > 0
									? `${selectedKeys.length} selected`
									: `${folders.length} folders • ${files.length} files`}
							</span>
							{dragActive ? (
								<span className="text-xs text-hc-red">{dragHint}</span>
							) : null}
						</div>
						<div className="overflow-x-auto">
							<table className="w-full text-left text-sm">
								<thead className="bg-white/[0.02] text-text-muted font-medium text-[11px] tracking-wide">
									<tr>
										<th className="px-4 py-3 w-12"> </th>
										<th className="px-4 py-3 w-12"> </th>
										<th className="px-4 py-3">Name</th>
										<th className="px-4 py-3">Modified</th>
										<th className="px-4 py-3">Size</th>
										<th className="px-4 py-3 text-right">Actions</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-white/5">
									{!loading && !error && rows.length === 0 ? (
										<tr>
											<td
												colSpan={6}
												className="px-6 py-16 text-center text-text-muted italic"
											>
												No files found.
											</td>
										</tr>
									) : null}

									{folders.map((folder) => (
										<tr
											key={folder.prefix}
											className="hover:bg-white/5 transition-colors cursor-pointer"
											onDoubleClick={() =>
												void loadFiles({
													prefix: folder.prefix,
													reset: true,
													query: "",
												})
											}
										>
											<td className="px-4 py-4" />
											<td className="px-4 py-4 text-hc-blue">
												<PhIcon className="ph ph-folder-open text-xl" />
											</td>
											<td className="px-4 py-3.5 font-medium text-white font-mono">
												<button
													type="button"
													onClick={() =>
														void loadFiles({
															prefix: folder.prefix,
															reset: true,
															query: "",
														})
													}
													className="hover:text-hc-blue"
												>
													{folder.name}
												</button>
											</td>
											<td className="px-4 py-3.5 text-text-muted text-xs whitespace-nowrap">
												—
											</td>
											<td className="px-4 py-3.5 text-text-muted">—</td>
											<td className="px-4 py-3.5 text-right">
												<div className="inline-flex gap-2">
													<button
														type="button"
														onClick={() => {
															openUploadModal(folder.prefix);
														}}
														className="text-xs font-medium text-text-muted hover:text-white"
													>
														Upload
													</button>
													<button
														type="button"
														onClick={() => setMoveTargetPrefix(folder.prefix)}
														className="text-xs font-medium text-text-muted hover:text-white"
													>
														Set target
													</button>
												</div>
											</td>
										</tr>
									))}

									{files.map((file) => {
										const selected = selectedKeys.includes(file.key);
										return (
											<tr
												key={file.key}
												className={`transition-colors ${selected ? "bg-hc-red/5" : "hover:bg-white/5"}`}
											>
												<td className="px-4 py-4">
													<input
														type="checkbox"
														checked={selected}
														onChange={(event) =>
															handleRowSelection(
																file.key,
																(event.nativeEvent as MouseEvent).shiftKey,
															)
														}
														className="rounded border-white/10 bg-black/30"
													/>
												</td>
												<td className="px-4 py-3.5 text-text-muted">
													<PhIcon
														className={`ph ${getFileIcon(file)} text-xl`}
													/>
												</td>
												<td className="px-4 py-3.5 font-medium text-white min-w-0">
													<div className="font-mono break-all">{file.name}</div>
													<div className="text-[11px] text-text-muted mt-0.5 break-all font-mono">
														{file.relativePath}
													</div>
												</td>
												<td className="px-4 py-3.5 text-text-muted text-xs whitespace-nowrap">
													{formatRelativeTime(file.lastModified)}
												</td>
												<td className="px-4 py-3.5 text-text-muted text-xs whitespace-nowrap">
													{formatBytes(file.size)}
												</td>
												<td className="px-4 py-3.5 text-right">
													<div className="inline-flex flex-wrap justify-end gap-2">
														<button
															type="button"
															onClick={() => void openPreview(file)}
															className="text-hc-blue hover:text-blue-400 text-xs font-medium"
														>
															Preview
														</button>
														<button
															type="button"
															onClick={() => openRename(file)}
															className="text-text-muted hover:text-white text-xs font-medium"
														>
															Rename
														</button>
														<button
															type="button"
															onClick={() => openMove([file.key])}
															className="text-text-muted hover:text-white text-xs font-medium"
														>
															Move
														</button>
														<button
															type="button"
															onClick={() => startDelete([file.key])}
															className="text-hc-red hover:text-red-400 text-xs font-medium"
														>
															Delete
														</button>
													</div>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>

						<div className="p-3 border-t border-white/10 flex flex-wrap justify-between items-center gap-3 bg-white/[0.02]">
							<div className="text-xs text-text-muted flex items-center gap-2">
								{loading ? (
									<>
										<PhIcon className="ph ph-spinner animate-spin text-sm text-hc-red" />
										<span>Loading...</span>
									</>
								) : error ? (
									<span className="text-red-400">{error}</span>
								) : selectedKeys.length > 0 ? (
									`${selectedKeys.length} selected`
								) : (
									`${folders.length} folders • ${files.length} files`
								)}
							</div>
							{(searchMeta.active && searchCursor) ||
							(!searchMeta.active && nextToken) ? (
								<button
									type="button"
									onClick={() => void loadMore()}
									className="text-text-muted hover:text-white text-sm font-bold py-2 px-4 rounded-lg hover:bg-white/5 transition-colors"
								>
									Load More
								</button>
							) : null}
						</div>
					</section>
				</div>

				{operation.error ? (
					<div className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
						{operation.error}
					</div>
				) : null}
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
									alt={previewKey}
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
								<PhIcon className="ph ph-file-x text-6xl text-text-muted mx-auto mb-4" />
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
				open={deleteTargets.length > 0}
				onClose={() => (operation.busy ? null : setDeleteTargets([]))}
				title={deleteTargets.length === 1 ? "Delete file" : "Delete files"}
				className="max-w-lg p-8"
			>
				<div className="space-y-4">
					<p className="text-text-muted">
						This action permanently deletes{" "}
						<span className="text-white">{deleteTargets.length}</span> file
						{deleteTargets.length === 1 ? "" : "s"} and updates storage
						accounting.
					</p>
					<div className="max-h-48 overflow-auto rounded-2xl border border-white/10 bg-black/20 p-3 space-y-2">
						{deleteTargets.map((key) => (
							<p key={key} className="text-sm font-mono text-white break-all">
								{key}
							</p>
						))}
					</div>
					<div className="flex justify-end gap-3">
						<button
							type="button"
							onClick={() => setDeleteTargets([])}
							disabled={operation.busy}
							className="text-text-muted hover:text-white px-4 py-2 text-sm font-bold transition-colors"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={() => void confirmDelete()}
							disabled={operation.busy}
							className="bg-hc-red hover:bg-red-600 text-white px-6 py-3 rounded-xl text-sm font-bold transition-all card-shadow flex items-center gap-2"
						>
							{operation.busy ? (
								<PhIcon className="ph ph-spinner animate-spin" />
							) : null}
							{operation.busy ? "Deleting..." : "Delete"}
						</button>
					</div>
				</div>
			</Modal>

			<Modal
				open={!!renameTarget}
				onClose={() => (operation.busy ? null : setRenameTarget(null))}
				title="Rename file"
				className="max-w-lg p-8"
			>
				<div className="space-y-4">
					<p className="text-text-muted text-sm">
						Only the filename changes; the file stays in{" "}
						<span className="text-white font-mono">
							{renameTarget?.parentPrefix || "root/"}
						</span>
						.
					</p>
					<input
						type="text"
						value={renameValue}
						onChange={(event) => setRenameValue(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void submitRename();
						}}
						className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-hc-blue"
					/>
					<div className="flex justify-end gap-3">
						<button
							type="button"
							onClick={() => setRenameTarget(null)}
							disabled={operation.busy}
							className="text-text-muted hover:text-white px-4 py-2 text-sm font-bold transition-colors"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={() => void submitRename()}
							disabled={operation.busy}
							className="bg-white/10 hover:bg-white/20 text-white px-6 py-3 rounded-xl text-sm font-bold transition-all card-shadow flex items-center gap-2"
						>
							{operation.busy ? (
								<PhIcon className="ph ph-spinner animate-spin" />
							) : null}
							{operation.busy ? "Renaming..." : "Rename"}
						</button>
					</div>
				</div>
			</Modal>

			<Modal
				open={moveOpen}
				onClose={() => (operation.busy ? null : setMoveOpen(false))}
				title="Move files"
				className="max-w-lg p-8"
			>
				<div className="space-y-4">
					<p className="text-text-muted text-sm">
						Move <span className="text-white">{selectedKeys.length}</span> file
						{selectedKeys.length === 1 ? "" : "s"} to another folder. Use{" "}
						<span className="text-white font-mono">folder/subfolder/</span>{" "}
						format or leave empty for root.
					</p>
					<input
						type="text"
						value={moveTargetPrefix}
						onChange={(event) => setMoveTargetPrefix(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void submitMove();
						}}
						placeholder="folder/subfolder/"
						className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-hc-blue"
					/>
					<div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
						<div className="flex items-center gap-2 text-sm font-mono overflow-x-auto whitespace-nowrap">
							{moveCrumbs.map((crumb, index) => (
								<Fragment key={crumb.prefix || "move-root"}>
									{index > 0 ? (
										<span className="text-text-muted">/</span>
									) : null}
									<button
										type="button"
										onClick={() => setMoveTargetPrefix(crumb.prefix)}
										className={
											index === moveCrumbs.length - 1
												? "text-white font-bold"
												: "text-text-muted hover:text-white"
										}
									>
										{crumb.label}
									</button>
								</Fragment>
							))}
						</div>
					</div>
					<div className="flex gap-2 flex-wrap">
						<button
							type="button"
							onClick={() => setMoveTargetPrefix(currentPrefix)}
							className="text-xs font-bold uppercase tracking-wider px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-text-muted hover:text-white"
						>
							Current folder
						</button>
						<button
							type="button"
							onClick={() =>
								setMoveTargetPrefix(getParentPrefix(currentPrefix))
							}
							disabled={!currentPrefix}
							className="text-xs font-bold uppercase tracking-wider px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-text-muted hover:text-white"
						>
							Parent folder
						</button>
						<button
							type="button"
							onClick={() => setMoveTargetPrefix("")}
							className="text-xs font-bold uppercase tracking-wider px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-text-muted hover:text-white"
						>
							Root
						</button>
					</div>
					<div className="flex justify-end gap-3">
						<button
							type="button"
							onClick={() => setMoveOpen(false)}
							disabled={operation.busy}
							className="text-text-muted hover:text-white px-4 py-2 text-sm font-bold transition-colors"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={() => void submitMove()}
							disabled={operation.busy}
							className="bg-white/10 hover:bg-white/20 text-white px-6 py-3 rounded-xl text-sm font-bold transition-all card-shadow flex items-center gap-2"
						>
							{operation.busy ? (
								<PhIcon className="ph ph-spinner animate-spin" />
							) : null}
							{operation.busy ? "Moving..." : "Move"}
						</button>
					</div>
				</div>
			</Modal>

			<Modal
				open={uploadOpen}
				onClose={() => (operation.busy ? null : setUploadOpen(false))}
				title="Upload files"
				className="max-w-2xl p-8"
			>
				<div className="space-y-5">
					<div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
						<div>
							<label
								htmlFor="upload-prefix-input"
								className="block text-xs font-bold uppercase tracking-wider text-text-muted mb-2"
							>
								Destination folder
							</label>
							<input
								id="upload-prefix-input"
								type="text"
								value={uploadPrefix}
								onChange={(event) => setUploadPrefix(event.target.value)}
								placeholder="folder/subfolder/"
								className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-hc-blue"
							/>
						</div>
						<div className="flex items-end">
							<div className="w-full flex gap-2">
								<button
									type="button"
									onClick={() => openSystemPicker("files")}
									className={`flex-1 px-4 py-3 rounded-xl text-sm font-bold transition-colors ${uploadMode === "files" ? "bg-hc-red text-white" : "bg-white/10 hover:bg-white/20 text-white"}`}
								>
									Files
								</button>
								<button
									type="button"
									onClick={() => openSystemPicker("folder")}
									className={`flex-1 px-4 py-3 rounded-xl text-sm font-bold transition-colors ${uploadMode === "folder" ? "bg-hc-red text-white" : "bg-white/10 hover:bg-white/20 text-white"}`}
								>
									Folder
								</button>
							</div>
						</div>
					</div>
					<div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
						<div className="flex items-center gap-2 text-sm font-mono overflow-x-auto whitespace-nowrap">
							{[{ label: "root", prefix: "" }, ...crumbs.slice(1)].map(
								(crumb, index) => (
									<Fragment key={crumb.prefix || "upload-root"}>
										{index > 0 ? (
											<span className="text-text-muted">/</span>
										) : null}
										<button
											type="button"
											onClick={() => setUploadPrefix(crumb.prefix)}
											className={
												normalizePrefix(uploadPrefix) ===
												normalizePrefix(crumb.prefix)
													? "text-white font-bold"
													: "text-text-muted hover:text-white"
											}
										>
											{crumb.label}
										</button>
									</Fragment>
								),
							)}
						</div>
					</div>
					<div className="rounded-2xl border border-white/10 bg-black/20 p-4 max-h-80 overflow-auto space-y-3">
						{uploadQueue.length === 0 ? (
							<div className="text-sm text-text-muted space-y-3">
								<p>
									Pick {uploadMode === "folder" ? "a folder" : "files"} to
									upload into{" "}
									<span className="text-white font-mono">
										{normalizePrefix(uploadPrefix) || "root/"}
									</span>
									.
								</p>
								<div className="flex flex-wrap gap-3">
									<button
										type="button"
										onClick={() => openSystemPicker(uploadMode)}
										className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-xl text-sm font-bold transition-colors"
									>
										Choose {uploadMode === "folder" ? "folder" : "files"}
									</button>
								</div>
							</div>
						) : (
							uploadQueue.map((file) => {
								const mapKey = `${file.name}:${file.size}:${file.lastModified}`;
								return (
									<div
										key={mapKey}
										className="rounded-2xl border border-white/10 bg-black/30 p-3"
									>
										<div className="flex items-center justify-between gap-3 mb-2">
											<div className="min-w-0">
												<p className="text-white font-mono text-sm truncate">
													{file.name}
												</p>
												<p className="text-text-muted text-xs">
													{formatBytes(file.size)}
												</p>
											</div>
											<button
												type="button"
												onClick={() =>
													setUploadQueue((prev) =>
														prev.filter(
															(item) =>
																`${item.name}:${item.size}:${item.lastModified}` !==
																mapKey,
														),
													)
												}
												className="text-text-muted hover:text-white text-xs font-bold uppercase tracking-wider"
											>
												Remove
											</button>
										</div>
										<input
											type="text"
											value={uploadPaths[mapKey] || file.name}
											onChange={(event) =>
												setUploadPaths((prev) => ({
													...prev,
													[mapKey]: event.target.value,
												}))
											}
											className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-hc-blue font-mono"
										/>
									</div>
								);
							})
						)}
					</div>
					<div className="flex justify-end gap-3">
						<button
							type="button"
							onClick={() => setUploadOpen(false)}
							disabled={operation.busy}
							className="text-text-muted hover:text-white px-4 py-2 text-sm font-bold transition-colors"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={() => void submitUpload()}
							disabled={operation.busy || uploadQueue.length === 0}
							className="bg-hc-red hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white px-6 py-3 rounded-xl text-sm font-bold transition-all card-shadow flex items-center gap-2"
						>
							{operation.busy ? (
								<PhIcon className="ph ph-spinner animate-spin" />
							) : null}
							{operation.busy
								? "Uploading..."
								: `Upload ${uploadQueue.length || ""}`}
						</button>
					</div>
				</div>
			</Modal>
		</AppShell>
	);
}
