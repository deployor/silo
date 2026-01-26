import { YswsService } from "../../services/ysws-service";
import { render } from "../../lib/view-engine";
import { context } from "../../lib/context";
import { users } from "../../db/schema";

export async function handleAdminYswsRequest(req: Request, user: typeof users.$inferSelect): Promise<Response> {
    const url = new URL(req.url);

    if (!user.isAdmin) {
        return new Response("Forbidden", { status: 403 });
    }

    // List submissions
    if (url.pathname === "/admin/ysws") {
        const submissions = await YswsService.getSubmissions();
        return new Response(await render("admin-ysws", {
            title: "YSWS Submissions",
            user,
            submissions,
            layout: "main"
        }), {
            headers: { "Content-Type": "text/html" },
        });
    }

    // Review submission (GET view or POST action)
    // Actually the user asked for "Make the admin thing a whoel seperate like really nice page that makes it easy to review each thing"
    // So let's make a detail view /admin/ysws/:id
    
    const match = url.pathname.match(/\/admin\/ysws\/([a-f0-9-]+)$/);
    if (match) {
        const id = match[1];
        const submission = await YswsService.getSubmissionById(id);
        
        if (!submission) {
            return new Response("Submission not found", { status: 404 });
        }

        if (req.method === "GET") {
            return new Response(await render("admin-ysws-review", {
                title: `Review: ${submission.projectName}`,
                user,
                submission,
                layout: "main"
            }), {
                headers: { "Content-Type": "text/html" },
            });
        }

        if (req.method === "POST") {
            const formData = await req.formData();
            const action = formData.get("action");
            const publicNotes = formData.get("adminNotesPublic") as string;
            const privateNotes = formData.get("adminNotesPrivate") as string;

            if (action === "approve") {
                await YswsService.approveSubmission(id, user.id, publicNotes, privateNotes);
            } else if (action === "reject") {
                await YswsService.rejectSubmission(id, user.id, publicNotes, privateNotes);
            }

            return new Response(null, {
                status: 302,
                headers: { Location: "/admin/ysws" },
            });
        }
    }

    return new Response("Not Found", { status: 404 });
}
