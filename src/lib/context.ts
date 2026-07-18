import { AsyncLocalStorage } from "node:async_hooks";
import type { buckets, users } from "../db/schema";

export interface RequestContext {
	requestId: string;
	traceId: string;
	startTime: number;
	user?: typeof users.$inferSelect;
	bucket?: typeof buckets.$inferSelect;
	mode?: "authenticated" | "public";
	isOffboardingExport?: boolean;
	offboardingExportSessionId?: string;
	ip: string;
	userAgent: string | null;
	method: string;
	path: string;
}

export const context = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | undefined {
	return context.getStore();
}
