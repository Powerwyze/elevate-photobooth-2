export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    has_gemini_key: !!process.env.GEMINI_API_KEY,
    has_supabase_url: !!process.env.SUPABASE_URL,
    has_supabase_key: !!process.env.SUPABASE_ANON_KEY,
    bucket: process.env.SUPABASE_BUCKET || 'elevate-photos',
  });
}
