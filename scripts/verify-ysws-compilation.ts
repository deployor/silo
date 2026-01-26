import { handleYswsRequest } from "../src/web/ysws";
import { handleAdminYswsRequest } from "../src/web/admin/ysws";
import { YswsService } from "../src/services/ysws-service";
import { yswsSubmissions } from "../src/db/schema";

console.log("YSWS modules imported successfully");

async function check() {
    try {
        // Just check if we can access the service methods (not running them)
        console.log("Service methods:", Object.keys(YswsService));
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

check();
