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
import { fetchJson } from "../shared/api/http";
import type { AppBootstrap, FrontendUser } from "../shared/types/app";
import { formatBytes } from "../shared/utils/format";

type FileItem = {
	key: string;
	name: string;
	size: number;
	lastModified: string;
	hitCount?: number;
	errorCount?: number;
	egressBytes?: number;
	lastAccessedAt?: string | null;
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
	totalFiles?: number;
	totalFolders?: number;
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

type FileInfoState = {
	file: FileItem;
	publicUrl: string | null;
	publicUrlOrigin: string | null;
	isPublic: boolean;
	contentType: string;
	analytics: {
		hitCount: number;
		errorCount: number;
		ingressBytes: number;
		egressBytes: number;
		lastAccessedAt: string | null;
		updatedAt: string | null;
	};
	previewUrl: string;
	downloadUrl: string;
	previewText: string;
	temporaryUrl: string;
	temporaryUrlExpiresAt: string | null;
	temporaryUrlDurationSeconds: number;
	temporaryUrlLoading: boolean;
	loading: boolean;
	error: string | null;
};

const PRESIGN_DURATION_PRESETS = [
	{ label: "1 hour", seconds: 60 * 60 },
	{ label: "6 hours", seconds: 6 * 60 * 60 },
	{ label: "1 day", seconds: 24 * 60 * 60 },
	{ label: "7 days", seconds: 7 * 24 * 60 * 60 },
	{ label: "30 days", seconds: 30 * 24 * 60 * 60 },
] as const;

const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif"];
const VIDEO_EXTS = ["mp4", "webm", "ogg", "mov", "mkv", "avi", "m4v"];
const AUDIO_EXTS = ["mp3", "wav", "aac", "m4a", "flac", "ogg", "opus"];
const ARCHIVE_EXTS = ["zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz"];
const PDF_EXTS = ["pdf"];
const TABLE_EXTS = ["csv", "tsv", "xlsx", "xls"];
const DOC_EXTS = ["doc", "docx", "rtf", "odt"];
const SLIDE_EXTS = ["ppt", "pptx", "key"];
const CODE_EXTS = [
	"js",
	"jsx",
	"ts",
	"tsx",
	"css",
	"scss",
	"html",
	"xml",
	"sql",
	"yml",
	"yaml",
	"py",
	"rs",
	"go",
	"java",
	"c",
	"cpp",
	"h",
	"hpp",
	"sh",
	"toml",
	"ini",
	"env",
	"json",
];
const TEXT_EXTS = ["txt", "md", "log"];

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
	if (VIDEO_EXTS.includes(file.extension)) return "ph-file-video";
	if (AUDIO_EXTS.includes(file.extension)) return "ph-file-audio";
	if (ARCHIVE_EXTS.includes(file.extension)) return "ph-file-zip";
	if (PDF_EXTS.includes(file.extension)) return "ph-file-pdf";
	if (TABLE_EXTS.includes(file.extension)) return "ph-file-csv";
	if (SLIDE_EXTS.includes(file.extension)) return "ph-file-slides";
	if (DOC_EXTS.includes(file.extension)) return "ph-file-doc";
	if (CODE_EXTS.includes(file.extension)) return "ph-file-code";
	if (TEXT_EXTS.includes(file.extension)) return "ph-file-text";
	return "ph-file";
}

function formatRelativeTime(value: string): string {
	const date = new Date(value);
	return date.toLocaleString();
}

function formatFileStatLine(file: FileItem): string {
	return [`${file.hitCount || 0} hits`, formatBytes(file.egressBytes || 0)].join(
		" • ",
	);
}

export function FilesPage({ bootstrap }: { bootstrap: AppBootstrap }) {
	const p = bootstrap.props as {
		user?: FrontendUser | null;
		bucketName: string;
		breadcrumbs?: string;
		bucketAccess?: {
			isCollaborative?: boolean;
			permissions?: string[];
			canReadFiles?: boolean;
			canWriteFiles?: boolean;
			ownerId?: string;
		};
	};

	const bucketName = p.bucketName;
	const bucketAccess = p.bucketAccess;
	const canWriteFiles = bucketAccess?.canWriteFiles !== false;
	const collaborationPermissions = bucketAccess?.permissions || [];
	const [search, setSearch] = useState("");
	const [searchScope, setSearchScope] = useState<"current" | "all">("current");
	const [currentPrefix, setCurrentPrefix] = useState(() => {
		const params = new URLSearchParams(window.location.search);
		return normalizePrefix(params.get("prefix") || "");
	});
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
	const [selectedFolderPrefixes, setSelectedFolderPrefixes] = useState<
		string[]
	>([]);
	const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);
	const [deleteTargets, setDeleteTargets] = useState<string[]>([]);
	const [deleteFolderTarget, setDeleteFolderTarget] =
		useState<FolderItem | null>(null);
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
	const [totals, setTotals] = useState({ files: 0, folders: 0 });

	const [infoOpen, setInfoOpen] = useState(false);
	const [infoState, setInfoState] = useState<FileInfoState | null>(null);

	const [previewOpen, setPreviewOpen] = useState(false);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [previewKey, setPreviewKey] = useState("");
	const [previewUrl, setPreviewUrl] = useState("");
	const [previewDownloadUrl, setPreviewDownloadUrl] = useState("");
	const [previewText, setPreviewText] = useState("");
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const folderInputRef = useRef<HTMLInputElement | null>(null);
	const currentPrefixRef = useRef("");
	const searchMetaRef = useRef(searchMeta);
	const previewObjectUrlRef = useRef<string | null>(null);
	const folderInputAttributes = {
		webkitdirectory: "true",
		directory: "true",
	} as unknown as Record<string, string>;

	const activePrefix = currentPrefix;

	useEffect(() => {
		currentPrefixRef.current = currentPrefix;
		const url = new URL(window.location.href);
		if (currentPrefix) {
			url.searchParams.set("prefix", currentPrefix);
		} else {
			url.searchParams.delete("prefix");
		}
		window.history.replaceState({}, "", url.toString());
	}, [currentPrefix]);

	useEffect(() => {
		searchMetaRef.current = searchMeta;
	}, [searchMeta]);

	useEffect(() => {
		return () => {
			if (previewObjectUrlRef.current) {
				URL.revokeObjectURL(previewObjectUrlRef.current);
				previewObjectUrlRef.current = null;
			}
		};
	}, []);

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
				setSelectedFolderPrefixes([]);
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
				setTotals({
					files: data.totalFiles || (data.files || []).length,
					folders: data.totalFolders || (data.folders || []).length,
				});
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
		const params = new URLSearchParams(window.location.search);
		const prefixFromUrl = normalizePrefix(params.get("prefix") || "");
		loadFiles({ prefix: prefixFromUrl, reset: true, query: "" });
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

	const selectedFolders = useMemo(
		() =>
			folders.filter((folder) =>
				selectedFolderPrefixes.includes(folder.prefix),
			),
		[folders, selectedFolderPrefixes],
	);

	const isMoveAtRoot = normalizePrefix(moveTargetPrefix) === "";

	const allVisibleFilesSelected =
		files.length > 0 && selectedFiles.length === files.length;
	const allVisibleFoldersSelected =
		folders.length > 0 && selectedFolders.length === folders.length;
	const allVisibleItemsSelected =
		(files.length === 0 || allVisibleFilesSelected) &&
		(folders.length === 0 || allVisibleFoldersSelected) &&
		(files.length > 0 || folders.length > 0);

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

	const _toggleAllVisibleFiles = () => {
		clearOperationError();
		if (allVisibleFilesSelected) {
			setSelectedKeys([]);
			return;
		}
		setSelectedKeys(files.map((file) => file.key));
	};

	const toggleFolderSelection = (prefix: string) => {
		clearOperationError();
		setSelectedFolderPrefixes((prev) =>
			prev.includes(prefix)
				? prev.filter((value) => value !== prefix)
				: [...prev, prefix],
		);
	};

	const _toggleAllVisibleFolders = () => {
		clearOperationError();
		if (allVisibleFoldersSelected) {
			setSelectedFolderPrefixes([]);
			return;
		}
		setSelectedFolderPrefixes(folders.map((folder) => folder.prefix));
	};

	const toggleAllVisibleItems = () => {
		clearOperationError();
		if (allVisibleItemsSelected) {
			setSelectedKeys([]);
			setSelectedFolderPrefixes([]);
			return;
		}
		setSelectedKeys(files.map((file) => file.key));
		setSelectedFolderPrefixes(folders.map((folder) => folder.prefix));
	};

	const openPreview = async (file: FileItem) => {
		if (previewObjectUrlRef.current) {
			URL.revokeObjectURL(previewObjectUrlRef.current);
			previewObjectUrlRef.current = null;
		}
		setPreviewOpen(true);
		setPreviewLoading(true);
		setPreviewError(null);
		setPreviewKey(file.key);
		setPreviewUrl("");
		setPreviewDownloadUrl("");
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
			setPreviewDownloadUrl(signed.url);

			const isTextPreview = TEXT_EXTS.includes(file.extension);
			if (!isTextPreview) {
				setPreviewUrl(signed.url);
			}

			const response = await fetch(signed.url, {
				credentials: "same-origin",
			});
			if (!response.ok) {
				throw new Error(`Preview failed (${response.status})`);
			}

			if (isTextPreview) {
				const text = await response.text();
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

	const openInfo = async (file: FileItem) => {
		if (previewObjectUrlRef.current) {
			URL.revokeObjectURL(previewObjectUrlRef.current);
			previewObjectUrlRef.current = null;
		}

		setInfoOpen(true);
		setInfoState({
			file,
			publicUrl: null,
			publicUrlOrigin: null,
			isPublic: false,
			contentType: "application/octet-stream",
			analytics: {
				hitCount: file.hitCount || 0,
				errorCount: file.errorCount || 0,
				ingressBytes: 0,
				egressBytes: file.egressBytes || 0,
				lastAccessedAt: file.lastAccessedAt || null,
				updatedAt: null,
			},
			previewUrl: "",
			downloadUrl: "",
			previewText: "",
			temporaryUrl: "",
			temporaryUrlExpiresAt: null,
			temporaryUrlDurationSeconds: PRESIGN_DURATION_PRESETS[0].seconds,
			temporaryUrlLoading: false,
			loading: true,
			error: null,
		});

		try {
			const [info, signed] = await Promise.all([
				fetchJson<{
					file: { key: string; size: number; contentType: string };
					analytics: {
						hitCount: number;
						errorCount: number;
						ingressBytes: number;
						egressBytes: number;
						lastAccessedAt: string | null;
						updatedAt: string | null;
					};
					publicUrl: string | null;
					isPublic: boolean;
				}>(
					`/api/dashboard/buckets/${bucketName}/files/info?key=${encodeURIComponent(file.key)}`,
				),
				fetchJson<{ url: string }>(
					`/api/dashboard/buckets/${bucketName}/files/sign`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ key: file.key }),
					},
				),
			]);

			const isTextPreview = TEXT_EXTS.includes(file.extension);
			let previewText = "";
			if (isTextPreview) {
				const response = await fetch(signed.url, {
					credentials: "same-origin",
				});
				if (!response.ok) {
					throw new Error(`Preview failed (${response.status})`);
				}
				previewText = await response.text();
			}

			setInfoState({
				file: {
					...file,
					hitCount: info.analytics.hitCount,
					errorCount: info.analytics.errorCount,
					egressBytes: info.analytics.egressBytes,
					lastAccessedAt: info.analytics.lastAccessedAt,
				},
				publicUrl: info.publicUrl,
				publicUrlOrigin: info.publicUrl ? new URL(info.publicUrl).origin : null,
				isPublic: info.isPublic,
				contentType: info.file.contentType,
				analytics: info.analytics,
				previewUrl: isTextPreview ? "" : signed.url,
				downloadUrl: signed.url,
				previewText,
				temporaryUrl: "",
				temporaryUrlExpiresAt: null,
				temporaryUrlDurationSeconds: PRESIGN_DURATION_PRESETS[0].seconds,
				temporaryUrlLoading: false,
				loading: false,
				error: null,
			});
		} catch (cause) {
			setInfoState({
				file,
				publicUrl: null,
				publicUrlOrigin: null,
				isPublic: false,
				contentType: "application/octet-stream",
				analytics: {
					hitCount: file.hitCount || 0,
					errorCount: file.errorCount || 0,
					ingressBytes: 0,
					egressBytes: file.egressBytes || 0,
					lastAccessedAt: file.lastAccessedAt || null,
					updatedAt: null,
				},
				previewUrl: "",
				downloadUrl: "",
				previewText: "",
				temporaryUrl: "",
				temporaryUrlExpiresAt: null,
				temporaryUrlDurationSeconds: PRESIGN_DURATION_PRESETS[0].seconds,
				temporaryUrlLoading: false,
				loading: false,
				error: cause instanceof Error ? cause.message : "Failed to load file info",
			});
		}
	};

	const generateTemporaryUrl = async () => {
		if (!infoState) return;
		setInfoState((prev) =>
			prev
				? {
						...prev,
						temporaryUrlLoading: true,
						error: null,
					}
				: prev,
		);

		try {
			const result = await fetchJson<{
				url: string;
				expiresAt: string;
				expiresSeconds: number;
			}>(`/api/dashboard/buckets/${bucketName}/files/sign`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					key: infoState.file.key,
					expiresSeconds: infoState.temporaryUrlDurationSeconds,
					share: true,
				}),
			});

			setInfoState((prev) =>
				prev
					? {
							...prev,
							temporaryUrl: result.url,
							temporaryUrlExpiresAt: result.expiresAt,
							temporaryUrlDurationSeconds: result.expiresSeconds,
							temporaryUrlLoading: false,
						}
					: prev,
			);
		} catch (cause) {
			setInfoState((prev) =>
				prev
					? {
							...prev,
							temporaryUrlLoading: false,
							error:
								cause instanceof Error
									? cause.message
									: "Failed to create temporary link",
						}
					: prev,
			);
		}
	};

	const startDelete = (keys: string[]) => {
		clearOperationError();
		setDeleteTargets(Array.from(new Set(keys)));
	};

	const startDeleteFolder = (folder: FolderItem) => {
		clearOperationError();
		setDeleteFolderTarget(folder);
	};

	const startDeleteSelection = () => {
		clearOperationError();
		if (selectedFolderPrefixes.length > 0) {
			setDeleteFolderTarget({
				prefix: `${selectedFolderPrefixes.length} selected folder(s)`,
				name: `${selectedFolderPrefixes.length} selected folder(s)`,
				type: "folder",
				parentPrefix: selectedKeys.length > 0 ? "__mixed__" : "",
			});
			return;
		}
		startDelete(selectedKeys);
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

	const confirmDeleteFolder = async () => {
		const prefixes = selectedFolderPrefixes;
		if (prefixes.length === 0) return;
		setOperation({ kind: "delete", busy: true, error: null });
		try {
			await fetchJson(`/api/dashboard/buckets/${bucketName}/files`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prefixes, keys: selectedKeys }),
			});
			setDeleteFolderTarget(null);
			setSelectedFolderPrefixes([]);
			setSelectedKeys([]);
			await refreshCurrentView();
			setOperation({ kind: null, busy: false, error: null });
		} catch (cause) {
			setOperation({
				kind: "delete",
				busy: false,
				error: cause instanceof Error ? cause.message : "Folder delete failed",
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
		if (!canWriteFiles) return;
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
			if (!canWriteFiles) return;
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
		[canWriteFiles, clearOperationError, currentPrefix],
	);

	const onFolderInputChange = (event: ChangeEvent<HTMLInputElement>) => {
		setUploadMode("folder");
		if (event.target.files) ingestFiles(event.target.files);
		event.target.value = "";
	};

	const openSystemPicker = (mode: "files" | "folder") => {
		if (!canWriteFiles) return;
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
	const previewFileName = previewKey.split("/").pop() || "download";

	return (
		<AppShell
			title={bootstrap.title}
			user={p.user || null}
			config={bootstrap.config}
			breadcrumbs={p.breadcrumbs}
		>
			<div className="max-w-[1400px] mx-auto w-full min-h-[72vh] flex flex-col">
				{!canWriteFiles ? (
					<div className="mb-4 rounded-3xl border border-white/10 bg-white/5 px-5 py-4 text-sm text-text-muted">
						This bucket is currently read-only. Uploads and other write actions are disabled.
					</div>
				) : null}
				{bucketAccess?.isCollaborative ? (
					<div className="mb-4 rounded-3xl border border-yellow-400/30 bg-yellow-400/10 px-5 py-4 text-sm text-yellow-100">
						<div className="flex flex-wrap items-center gap-3">
							<span className="inline-flex items-center gap-2 font-bold uppercase tracking-wider text-[11px] text-yellow-200">
								<i className="ph ph-handshake text-base" /> Shared bucket
							</span>
							<span>
								You are collaborating on{" "}
								<span className="font-mono">{bucketName}</span>
								{bucketAccess.ownerId ? (
									<>
										{" "}
										with owner{" "}
										<span className="font-mono">{bucketAccess.ownerId}</span>
									</>
								) : null}
								.
							</span>
						</div>
						<div className="mt-3 flex flex-wrap gap-2">
							{collaborationPermissions.map((permission) => (
								<span
									key={permission}
								 className="rounded-full border border-yellow-300/30 bg-black/20 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider"
								>
									{permission.replace(/_/g, " ")}
								</span>
							))}
							{!canWriteFiles ? (
								<span className="rounded-full border border-white/15 bg-black/20 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-white/80">
									Read only
								</span>
							) : null}
						</div>
					</div>
				) : null}
				<div className="bg-hc-dark rounded-[28px] border border-white/10 overflow-hidden card-shadow flex-1 flex flex-col">
					<div className="px-4 py-3 border-b border-white/10 bg-white/[0.03] flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
						<div className="flex items-center gap-3 min-w-0">
							<PhIcon className="ph ph-folder-open text-xl text-hc-red shrink-0" />
							<div className="min-w-0">
								<h1 className="text-xl font-bold text-white truncate">
									{bucketName}
								</h1>
							</div>
						</div>
						<div className="flex flex-wrap gap-2">
							<button
								type="button"
								onClick={() => {
									openUploadModal(currentPrefix);
								}}
								disabled={!canWriteFiles}
							 className="bg-hc-red hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3.5 py-2 rounded-xl text-sm font-bold transition-colors"
							>
								Upload
							</button>
							<button
								type="button"
								disabled={
									!canWriteFiles ||
									selectedKeys.length === 0 ||
									selectedFolderPrefixes.length > 0
								}
								onClick={() => openMove()}
							 className="bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3.5 py-2 rounded-xl text-sm font-bold transition-colors"
							>
								Move
							</button>
							<button
								type="button"
								disabled={
									!canWriteFiles ||
									(selectedKeys.length === 0 &&
										selectedFolderPrefixes.length === 0)
								}
								onClick={startDeleteSelection}
							 className="bg-hc-red/85 hover:bg-hc-red disabled:opacity-40 disabled:cursor-not-allowed text-white px-3.5 py-2 rounded-xl text-sm font-bold transition-colors"
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
								 className="bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-hc-red flex-1"
								/>
								<div className="inline-flex rounded-xl border border-white/10 overflow-hidden bg-black/20">
									<button
										type="button"
										onClick={() => setSearchScope("current")}
									 className={`px-4 py-3 text-sm font-bold transition-colors ${searchScope === "current" ? "bg-hc-red text-white" : "text-text-muted hover:text-white"}`}
									>
										This folder
									</button>
									<button
										type="button"
										onClick={() => setSearchScope("all")}
									 className={`px-4 py-3 text-sm font-bold transition-colors ${searchScope === "all" ? "bg-hc-red text-white" : "text-text-muted hover:text-white"}`}
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
									 className="text-yellow-300 hover:text-yellow-200 hover:bg-yellow-500/10 px-4 py-3 rounded-xl text-sm font-bold transition-colors"
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
						className={`flex-1 flex flex-col transition-colors ${dragActive ? "border-hc-red" : "border-white/10"}`}
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
									checked={allVisibleItemsSelected}
									onChange={toggleAllVisibleItems}
								 className="rounded border-white/10 bg-black/30"
								/>
								Select visible
							</label>
							{selectedKeys.length > 0 ? (
								<span className="text-xs text-text-muted">
									{selectedKeys.length} selected
								</span>
							) : null}
							{dragActive ? (
								<span className="text-xs text-hc-red">{dragHint}</span>
							) : null}
						</div>
						<div className="overflow-x-auto flex-1">
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
											<td className="px-4 py-4">
												<input
													type="checkbox"
													checked={selectedFolderPrefixes.includes(
														folder.prefix,
													)}
												 onChange={() => toggleFolderSelection(folder.prefix)}
												 className="rounded border-white/10 bg-black/30"
												/>
											</td>
											<td className="px-4 py-4 text-hc-red">
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
												 className="hover:text-hc-red"
												>
													{folder.name}
												</button>
											</td>
											<td className="px-4 py-3.5 text-text-muted text-xs whitespace-nowrap">
												—
											</td>
											<td className="px-4 py-3.5 text-text-muted">—</td>
											<td className="px-4 py-3.5 text-right">
												<button
													type="button"
												 onClick={() => startDeleteFolder(folder)}
												 disabled={!canWriteFiles}
												 className="text-hc-red hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium"
												>
													Delete
												</button>
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
													<div className="text-[11px] text-text-muted mt-0.5 break-all">
														{formatFileStatLine(file)}
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
															onClick={() => void openInfo(file)}
														 className="text-white hover:text-gray-300 text-xs font-medium"
														>
															Info
														</button>
														<button
															type="button"
															onClick={() => void openPreview(file)}
														 className="text-hc-red hover:text-hc-red text-xs font-medium"
														>
															Preview
														</button>
														<button
															type="button"
															onClick={() => openRename(file)}
															disabled={!canWriteFiles}
														 className="text-text-muted hover:text-white disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium"
														>
															Rename
														</button>
														<button
															type="button"
															onClick={() => openMove([file.key])}
															disabled={!canWriteFiles}
														 className="text-text-muted hover:text-white disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium"
														>
															Move
														</button>
														<button
															type="button"
															onClick={() => startDelete([file.key])}
															disabled={!canWriteFiles}
														 className="text-hc-red hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium"
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
								) : selectedKeys.length > 0 ||
									selectedFolderPrefixes.length > 0 ? (
									`${selectedFolderPrefixes.length} folders • ${selectedKeys.length} files selected`
								) : null}
								<span className="text-text-muted/70">
									{totals.folders} folders • {totals.files} files total
								</span>
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
				onClose={() => {
					setPreviewOpen(false);
					if (previewObjectUrlRef.current) {
						URL.revokeObjectURL(previewObjectUrlRef.current);
						previewObjectUrlRef.current = null;
					}
					setPreviewUrl("");
					setPreviewDownloadUrl("");
					setPreviewText("");
				}}
				className="max-w-5xl p-8"
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
			</Modal>

			{infoOpen && infoState && (
				<Modal
					open={infoOpen}
					onClose={() => {
						setInfoOpen(false);
						setInfoState(null);
					}}
					className="max-w-5xl p-8"
				>
					<div className="space-y-8">
						<div className="flex items-start justify-between gap-4 border-b border-white/10 pb-5">
							<div className="min-w-0">
								<p className="text-xs font-bold uppercase tracking-[0.22em] text-text-muted">
									Object details
								</p>
								<h2 className="mt-2 break-all font-mono text-xl text-white">
									{infoState.file.key}
								</h2>
							</div>
							<div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
								<button
									type="button"
									onClick={() => {
										setInfoOpen(false);
										void openPreview(infoState.file);
									}}
								 className="rounded-xl bg-white/10 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-white/20"
								>
									Preview
								</button>
								{infoState.downloadUrl ? (
									<a
										href={infoState.downloadUrl}
										download={infoState.file.name}
									 className="rounded-xl bg-hc-red px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-red-500"
									>
										Download
									</a>
								) : null}
							</div>
						</div>

						<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
							<div>
								<div className="mb-1 text-xs text-text-muted">Modified</div>
								<div className="text-sm text-white">
									{formatRelativeTime(infoState.file.lastModified)}
								</div>
							</div>
							<div>
								<div className="mb-1 text-xs text-text-muted">Type</div>
								<div className="break-all text-sm text-white">
									{infoState.contentType}
								</div>
							</div>
							<div>
								<div className="mb-1 text-xs text-text-muted">Visibility</div>
								<div className="text-sm text-white">
									{infoState.isPublic ? "Public" : "Private"}
								</div>
							</div>
							<div>
								<div className="mb-1 text-xs text-text-muted">Size</div>
								<div className="text-sm text-white">
									{formatBytes(infoState.file.size)}
								</div>
							</div>
						</div>

						{infoState.error ? (
							<div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
								{infoState.error}
							</div>
						) : null}

						<div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(320px,1.1fr)]">
							<div className="space-y-8">
								<div className="border-t border-white/10 pt-6">
									<h3 className="mb-4 text-lg font-bold text-white">URLs</h3>
									{infoState.isPublic && infoState.publicUrl ? (
										<div>
											{infoState.publicUrlOrigin ? (
												<div className="mb-3 text-xs text-text-muted">
													Primary domain: <span className="font-mono text-white">{infoState.publicUrlOrigin}</span>
												</div>
											) : null}
											<div className="mb-2 text-xs text-text-muted">Public object URL</div>
											<div className="flex items-center gap-2">
												<input
													type="text"
													readOnly
													value={infoState.publicUrl}
												 className="flex-1 rounded-xl border border-white/10 bg-black/30 px-4 py-3 font-mono text-sm text-white focus:outline-none"
												/>
												<button
													type="button"
													onClick={() => {
														void navigator.clipboard.writeText(infoState.publicUrl || "");
													}}
												 className="rounded-xl bg-white/10 p-3 transition-colors hover:bg-white/20"
												 title="Copy to clipboard"
												>
													<PhIcon className="ph ph-copy text-white" />
												</button>
											</div>
										</div>
								) : (
									<div className="text-sm text-text-muted">
										This object does not have a public URL because this bucket is private.
									</div>
								)}
								{!infoState.isPublic ? (
									<div className="mt-6">
										<div className="mb-2 text-xs text-text-muted">
											Temporary presigned URL
										</div>
										<div className="flex flex-wrap gap-2 mb-3">
											<select
												value={infoState.temporaryUrlDurationSeconds}
												onChange={(event) =>
													setInfoState((prev) =>
														prev
															? {
																...prev,
																temporaryUrlDurationSeconds: Number(event.target.value),
															}
															: prev,
													)
												}
												className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 font-mono text-sm text-white"
											>
												{PRESIGN_DURATION_PRESETS.map((preset) => (
													<option key={preset.seconds} value={preset.seconds}>
														{preset.label}
													</option>
												))}
											</select>
											<button
												type="button"
												onClick={() => void generateTemporaryUrl()}
												disabled={infoState.temporaryUrlLoading}
												className="rounded-xl bg-white/10 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-white/20 disabled:opacity-50"
											>
												{infoState.temporaryUrlLoading ? "Generating..." : "Generate link"}
											</button>
										</div>
												{infoState.temporaryUrl ? (
													<>
														<p className="mb-2 text-xs text-text-muted">
															Shared link host: <span className="font-mono text-white">{(() => {
																try {
																	return new URL(infoState.temporaryUrl).origin;
																} catch {
																	return "—";
																}
															})()}</span>
														</p>
														<div className="flex items-center gap-2">
													<input
														type="text"
														readOnly
														value={infoState.temporaryUrl}
														className="flex-1 rounded-xl border border-white/10 bg-black/30 px-4 py-3 font-mono text-sm text-white focus:outline-none"
													/>
													<button
														type="button"
														onClick={() => {
															void navigator.clipboard.writeText(infoState.temporaryUrl);
														}}
														className="rounded-xl bg-white/10 p-3 transition-colors hover:bg-white/20"
														title="Copy temporary link"
													>
														<PhIcon className="ph ph-copy text-white" />
													</button>
												</div>
												{infoState.temporaryUrlExpiresAt ? (
													<p className="mt-2 text-xs text-text-muted">
														Expires {new Date(infoState.temporaryUrlExpiresAt).toLocaleString()}
													</p>
												) : null}
											</>
										) : (
											<p className="text-sm text-text-muted">
												Generate a temporary private link for up to 30 days.
											</p>
										)}
									</div>
								) : null}
							</div>

								<div className="border-t border-white/10 pt-6">
									<h3 className="mb-4 text-lg font-bold text-white">Object info</h3>
									<div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm">
										<div className="flex items-start justify-between gap-4">
											<span className="text-text-muted">Filename</span>
											<span className="max-w-[70%] break-all font-mono text-white">
												{infoState.file.name}
											</span>
										</div>
										<div className="flex items-start justify-between gap-4">
											<span className="text-text-muted">Path</span>
											<span className="max-w-[70%] break-all font-mono text-white">
												{infoState.file.relativePath}
											</span>
										</div>
										<div className="flex items-start justify-between gap-4">
											<span className="text-text-muted">Statistics</span>
											<span className="max-w-[70%] text-right text-white">
												{infoState.analytics.hitCount.toLocaleString()} hits • {formatBytes(infoState.analytics.egressBytes)} egress • {infoState.analytics.errorCount.toLocaleString()} errors
											</span>
										</div>
										<div className="flex items-start justify-between gap-4">
											<span className="text-text-muted">Last access</span>
											<span className="max-w-[70%] text-right text-white">
												{infoState.analytics.lastAccessedAt
													? formatRelativeTime(infoState.analytics.lastAccessedAt)
													: "No hits yet"}
											</span>
										</div>
										<div className="flex items-start justify-between gap-4">
											<span className="text-text-muted">Analytics updated</span>
											<span className="max-w-[70%] text-right text-white">
												{infoState.analytics.updatedAt
													? formatRelativeTime(infoState.analytics.updatedAt)
													: "—"}
											</span>
										</div>
										<div className="flex items-start justify-between gap-4">
											<span className="text-text-muted">Extension</span>
											<span className="font-mono text-white">
												{infoState.file.extension || "—"}
											</span>
										</div>
									</div>
								</div>
							</div>

							<div className="border-t border-white/10 pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
								<h3 className="mb-4 text-lg font-bold text-white">Inline preview</h3>
								<div className="overflow-hidden rounded-2xl border border-white/10 bg-black/20">
									{infoState.loading ? (
										<div className="flex min-h-[320px] items-center justify-center text-text-muted">
											Loading preview...
										</div>
									) : infoState.error ? (
										<div className="flex min-h-[320px] items-center justify-center px-6 text-center text-hc-red">
											{infoState.error}
										</div>
									) : infoState.previewUrl ? (
										IMAGE_EXTS.includes(infoState.file.extension) ? (
											<div className="flex min-h-[320px] items-center justify-center p-4">
												<img
													src={infoState.previewUrl}
													alt={infoState.file.key}
												 className="max-h-[420px] max-w-full rounded object-contain"
												/>
											</div>
										) : VIDEO_EXTS.includes(infoState.file.extension) ? (
											<div className="p-4">
												<video
													src={infoState.previewUrl}
													controls
												 className="max-h-[420px] w-full rounded"
												>
													<track kind="captions" />
												</video>
											</div>
										) : AUDIO_EXTS.includes(infoState.file.extension) ? (
											<div className="flex min-h-[320px] items-center justify-center p-6">
												<audio src={infoState.previewUrl} controls className="w-full">
													<track kind="captions" />
												</audio>
											</div>
										) : (
											<div className="flex min-h-[320px] flex-col items-center justify-center px-6 text-center text-text-muted">
												<PhIcon className="ph ph-file text-4xl mb-3" />
												<p>No inline preview available.</p>
											</div>
										)
									) : infoState.previewText ? (
										<pre className="max-h-[420px] overflow-auto p-4 whitespace-pre-wrap break-words font-mono text-sm text-white">
											{infoState.previewText}
										</pre>
									) : (
										<div className="flex min-h-[320px] flex-col items-center justify-center px-6 text-center text-text-muted">
											<PhIcon className="ph ph-file text-4xl mb-3" />
											<p>No inline preview available.</p>
										</div>
									)}
								</div>
							</div>
						</div>
					</div>
				</Modal>
			)}

			<Modal
				open={deleteTargets.length > 0}
				onClose={() => (operation.busy ? null : setDeleteTargets([]))}
				title={deleteTargets.length === 1 ? "Delete file" : "Delete files"}
			 className="max-w-lg p-8"
			>
				<div className="space-y-4">
					<p className="text-text-muted">
						Delete <span className="text-white">{deleteTargets.length}</span> file
						{deleteTargets.length === 1 ? "" : "s"}.
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
				open={!!deleteFolderTarget}
				onClose={() => {
					if (operation.busy) return;
					setDeleteFolderTarget(null);
				}}
				title="Delete folder"
			 className="max-w-lg p-8"
			>
				<div className="space-y-4">
					<p className="text-text-muted">
						This deletes{" "}
						{deleteFolderTarget?.parentPrefix === "__mixed__"
							? "the selected folders and files"
							: deleteFolderTarget
								? "the folder"
								: "the selected folders"}{" "}
						<span className="text-white font-mono">
							{deleteFolderTarget?.parentPrefix === "__mixed__"
								? `${selectedFolderPrefixes.length} folders + ${selectedKeys.length} files`
								: deleteFolderTarget?.prefix ||
									`${selectedFolderPrefixes.length} folders`}
						</span>{" "}
						and everything inside it.
					</p>
					<div className="flex justify-end gap-3">
						<button
							type="button"
							onClick={() => setDeleteFolderTarget(null)}
							disabled={operation.busy}
						 className="text-text-muted hover:text-white px-4 py-2 text-sm font-bold transition-colors"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={() => void confirmDeleteFolder()}
							disabled={operation.busy}
						 className="bg-hc-red hover:bg-red-600 text-white px-6 py-3 rounded-xl text-sm font-bold transition-all card-shadow flex items-center gap-2"
						>
							{operation.busy ? (
								<PhIcon className="ph ph-spinner animate-spin" />
							) : null}
							{operation.busy ? "Deleting..." : "Delete folder"}
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
					 className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-hc-red"
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
					 className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-hc-red"
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
											normalizePrefix(moveTargetPrefix) ===
											normalizePrefix(crumb.prefix)
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
						{!isMoveAtRoot ? (
							<button
								type="button"
								onClick={() =>
									setMoveTargetPrefix((prev) => getParentPrefix(prev))
								}
							 className="text-xs font-bold uppercase tracking-wider px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-text-muted hover:text-white"
							>
								Parent folder
							</button>
						) : null}
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
							 className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-hc-red"
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
										 className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-hc-red font-mono"
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
