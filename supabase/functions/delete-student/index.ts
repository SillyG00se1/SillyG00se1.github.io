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

    if (!name || name.length > 200) {
      return respond({ error: "A valid student name is required." }, 400);
    }
    if (!["delete-profile", "reset-results"].includes(action)) {
      return respond({ error: "Unsupported teacher action." }, 400);
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
