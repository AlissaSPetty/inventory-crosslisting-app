import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  PORT: z.coerce.number().optional().default(3001),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  API_PUBLIC_URL: z.string().url(),
  PUBLIC_WEB_URL: z.string().url().optional().default("http://localhost:5173"),
  APP_ENCRYPTION_KEY: z.string().min(32),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  EBAY_CLIENT_ID: z.string().optional(),
  EBAY_CLIENT_SECRET: z.string().optional(),
  EBAY_RU_NAME: z.string().optional(),
  EBAY_SANDBOX: z.string().optional().default("true"),
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  /** Must be a leaf category ID (Inventory API rejects parent categories, error 25005). */
  EBAY_DEFAULT_CATEGORY_ID: z.string().optional().default("15687"),
  EBAY_MARKETPLACE_ID: z.string().optional().default("EBAY_US"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment variables");
  }
  return parsed.data;
}
