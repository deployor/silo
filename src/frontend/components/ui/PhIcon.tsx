import type { SVGProps } from "react";
import type { IconType } from "react-icons";
import { FaCrown, FaGithub } from "react-icons/fa6";
import {
	MdAcUnit,
	MdAdd,
	MdArchive,
	MdArrowBack,
	MdArrowForward,
	MdArrowOutward,
	MdAudiotrack,
	MdAutorenew,
	MdBrokenImage,
	MdCalendarMonth,
	MdCheck,
	MdCheckCircle,
	MdClose,
	MdCloudUpload,
	MdCode,
	MdCollections,
	MdContentCopy,
	MdDataset,
	MdDescription,
	MdDeleteOutline,
	MdDownload,
	MdErrorOutline,
	MdFilePresent,
	MdFolder,
	MdFolderOpen,
	MdHub,
	MdImage,
	MdInventory2,
	MdKey,
	MdLock,
	MdMonitorHeart,
	MdMovie,
	MdPictureAsPdf,
	MdRocketLaunch,
	MdShield,
	MdSlideshow,
	MdSync,
	MdTableChart,
	MdTextSnippet,
	MdThunderstorm,
	MdTune,
	MdWarning,
	MdWavingHand,
} from "react-icons/md";

const PH_WEIGHTS = new Set([
	"ph",
	"ph-bold",
	"ph-fill",
	"ph-duotone",
	"ph-thin",
]);

const ICONS: Record<string, IconType> = {
	"ph-x": MdClose,
	"ph-arrow-left": MdArrowBack,
	"ph-arrow-right": MdArrowForward,
	"ph-arrow-up-right": MdArrowOutward,
	"ph-arrow-square-out": MdArrowOutward,
	"ph-plus": MdAdd,
	"ph-list": MdTune,
	"ph-funnel": MdTune,
	"ph-database": MdDataset,
	"ph-arrows-clockwise": MdAutorenew,
	"ph-hard-drives": MdHub,
	"ph-heartbeat": MdMonitorHeart,
	"ph-key": MdKey,
	"ph-lightning": MdThunderstorm,
	"ph-fire": MdWarning,
	"ph-file": MdFilePresent,
	"ph-file-x": MdBrokenImage,
	"ph-file-text": MdDescription,
	"ph-file-code": MdCode,
	"ph-file-js": MdCode,
	"ph-file-ts": MdCode,
	"ph-file-css": MdCode,
	"ph-file-html": MdCode,
	"ph-file-json": MdCode,
	"ph-file-video": MdMovie,
	"ph-file-audio": MdAudiotrack,
	"ph-file-zip": MdArchive,
	"ph-file-pdf": MdPictureAsPdf,
	"ph-file-csv": MdTableChart,
	"ph-file-doc": MdTextSnippet,
	"ph-file-slides": MdSlideshow,
	"ph-folder": MdFolder,
	"ph-folder-open": MdFolderOpen,
	"ph-image": MdImage,
	"ph-image-broken": MdBrokenImage,
	"ph-images": MdCollections,
	"ph-calendar-blank": MdCalendarMonth,
	"ph-check": MdCheck,
	"ph-check-circle": MdCheckCircle,
	"ph-warning": MdWarning,
	"ph-warning-circle": MdErrorOutline,
	"ph-cloud-arrow-up": MdCloudUpload,
	"ph-copy": MdContentCopy,
	"ph-github-logo": FaGithub,
	"ph-rocket-launch": MdRocketLaunch,
	"ph-package": MdInventory2,
	"ph-crown": FaCrown,
	"ph-lock-key": MdLock,
	"ph-shield-check": MdShield,
	"ph-cloud-check": MdCloudUpload,
	"ph-download": MdDownload,
	"ph-hand-waving": MdWavingHand,
	"ph-spinner": MdSync,
	"ph-snowflake": MdAcUnit,
};

function pickIconToken(tokens: string[]): string | null {
	for (let i = tokens.length - 1; i >= 0; i -= 1) {
		const token = tokens[i];
		if (token.startsWith("ph-") && !PH_WEIGHTS.has(token)) return token;
	}
	return null;
}

export function PhIcon({ className = "", ...rest }: SVGProps<SVGSVGElement>) {
	const tokens = className.split(/\s+/).filter(Boolean);
	const iconToken = pickIconToken(tokens);
	const Icon = (iconToken && ICONS[iconToken]) || MdWarning;
	const filteredClassName = tokens
		.filter((t) => !PH_WEIGHTS.has(t) && t !== iconToken)
		.join(" ");

	return <Icon className={filteredClassName} {...rest} />;
}
