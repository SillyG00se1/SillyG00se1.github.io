import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://sillyg00se1.github.io",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  const respond = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ error: "POST required." }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return respond({ error: "Please sign in as a teacher first." }, 401);
    }

    const url = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anonKey || !serviceKey) {
      console.error("Required Supabase function environment variables are missing.");
      return respond({ error: "Server configuration is incomplete." }, 500);
    }

    // Validate the Supabase Auth access token; never trust a client-supplied email.
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();

    if (authError || !user?.email) {
      return respond({ error: "Invalid or expired teacher sign-in." }, 401);
    }

    const allowedEmails = (Deno.env.get("TEACHER_EMAILS") ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);

    if (!allowedEmails.includes(user.email.toLowerCase())) {
      return respond({ error: "This account is not authorized for teacher actions." }, 403);
    }

    const body = await req.json();
    const action = body?.action;
    const name = typeof body?.name === "string" ? body.name.trim() : "";

    if (!["delete-profile", "rename-profile", "reset-results"].includes(action)) {
      return respond({ error: "Unsupported teacher action." }, 400);
    }
    // Rename supplies oldName/newName; other actions require name.
    if (action !== "rename-profile" && (!name || name.length > 200)) {
      return respond({ error: "A valid student name is required." }, 400);
    }

    // This elevated key remains on the server and must never be exposed in HTML.
    const admin = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    if (action === "delete-profile") {
      const { data: existing, error: lookupError } = await admin
        .from("typing_students")
        .select("name")
        .eq("name", name)
        .maybeSingle();

      if (lookupError) throw lookupError;
      if (!existing) return respond({ error: "Student profile not found." }, 404);

      const { data: deletedRows, error: deleteError } = await admin
        .from("typing_students")
        .delete()
        .eq("name", name)
        .select("name");

      if (deleteError) throw deleteError;
      if (!deletedRows?.some((row) => row.name === name)) {
        return respond({ error: "The student profile deletion could not be verified." }, 500);
      }

      // Deliberately leave typing_results unchanged.
      return respond({ success: true, action, deleted: name, resultsPreserved: true });
    }

    if (action === "rename-profile") {
      const oldName = typeof body?.oldName === "string" ? body.oldName.trim() : "";
      const newName = typeof body?.newName === "string" ? body.newName.trim() : "";
      if (!oldName || oldName.length > 200 || !newName || newName.length > 200) {
        return respond({ error: "A valid old and new student name are required." }, 400);
      }
      if (oldName === newName) return respond({ error: "The new name is unchanged." }, 400);

      const { data: oldProfile, error: oldLookupError } = await admin
        .from("typing_students").select("name").eq("name", oldName).maybeSingle();
      if (oldLookupError) throw oldLookupError;
      if (!oldProfile) return respond({ error: "Student profile not found." }, 404);

      const { data: targetProfile, error: targetLookupError } = await admin
        .from("typing_students").select("name").eq("name", newName).maybeSingle();
      if (targetLookupError) throw targetLookupError;
      if (targetProfile) return respond({ error: "A student with that name already exists." }, 409);

      const { data: updatedProfiles, error: profileUpdateError } = await admin
        .from("typing_students").update({ name: newName }).eq("name", oldName).select("name");
      if (profileUpdateError) throw profileUpdateError;
      if (!updatedProfiles?.some((row) => row.name === newName)) {
        return respond({ error: "Supabase could not verify the profile rename." }, 500);
      }

      try {
        const { error: resultsUpdateError } = await admin
          .from("typing_results").update({ student: newName }).eq("student", oldName);
        if (resultsUpdateError) throw resultsUpdateError;

        const [{ data: oldProfiles, error: oldProfileCheckError },
               { data: newProfiles, error: newProfileCheckError },
               { data: oldResults, error: oldResultsCheckError },
               { data: renamedResults, error: renamedResultsCheckError }] = await Promise.all([
          admin.from("typing_students").select("name").eq("name", oldName),
          admin.from("typing_students").select("name").eq("name", newName),
          admin.from("typing_results").select("id").eq("student", oldName),
          admin.from("typing_results").select("id,student").eq("student", newName),
        ]);
        if (oldProfileCheckError) throw oldProfileCheckError;
        if (newProfileCheckError) throw newProfileCheckError;
        if (oldResultsCheckError) throw oldResultsCheckError;
        if (renamedResultsCheckError) throw renamedResultsCheckError;
        if (oldProfiles?.length || newProfiles?.length !== 1 || oldResults?.length ||
            renamedResults?.some((row) => row.student !== newName)) {
          throw new Error("Rename verification failed.");
        }
      } catch (verificationError) {
        // Best-effort rollback keeps the profile consistent if result migration fails.
        await admin.from("typing_results").update({ student: oldName }).eq("student", newName);
        await admin.from("typing_students").update({ name: oldName }).eq("name", newName);
        console.error("Student rename verification failed; rollback attempted.", verificationError);
        return respond({ error: "The rename could not be verified. The server attempted to roll it back; refresh and check the student and results tables." }, 500);
      }

      return respond({ success: true, action, oldName, newName, resultsUpdated: true });
    }

    // reset-results deletes only results belonging to this exact student name.
    const { data: beforeRows, error: beforeError } = await admin
      .from("typing_results")
      .select("id")
      .eq("student", name);

    if (beforeError) throw beforeError;

    const { error: deleteResultsError } = await admin
      .from("typing_results")
      .delete()
      .eq("student", name);

    if (deleteResultsError) throw deleteResultsError;

    const { data: remainingRows, error: verifyError } = await admin
      .from("typing_results")
      .select("id")
      .eq("student", name);

    if (verifyError) throw verifyError;
    if (remainingRows?.length) {
      console.error("Results reset verification failed for an authorized request.");
      return respond({ error: "Some typing results remain; the reset could not be verified." }, 500);
    }

    return respond({
      success: true,
      action,
      student: name,
      deletedCount: beforeRows?.length ?? 0,
      profilePreserved: true,
    });
  } catch (error) {
    console.error("delete-student Edge Function error:", error);
    return respond({ error: "The teacher action failed. Check the function logs." }, 500);
  }
});
