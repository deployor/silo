import { getCurrentUser } from "../../lib/session";
import { render } from "../../lib/view-engine";
import { YswsService } from "../../services/ysws-service";

export async function handleGalleryRequest(req: Request): Promise<Response> {
	const user = await getCurrentUser(req);
	const galleryProjects = await YswsService.getPublicApprovedSubmissions();

	return new Response(
		await render("gallery", {
			title: "YSWS Gallery",
			user,
			galleryProjects,
		}),
		{
			headers: { "Content-Type": "text/html" },
		},
	);
}
