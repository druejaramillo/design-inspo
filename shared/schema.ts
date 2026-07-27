import { z } from "zod";

export const paletteColorSchema = z.object({
  hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  role: z.string().min(1).max(80),
});

export const analysisSchema = z.object({
  version: z.literal(1),
  provider: z.enum(["opencode", "openai"]),
  analyzedAt: z.string().datetime(),
  palette: z.array(paletteColorSchema).min(2).max(8),
  style: z.array(z.string().min(1)).max(12),
  tone: z.array(z.string().min(1)).max(8),
  layout: z.array(z.string().min(1)).max(8),
  typography: z.array(z.string().min(1)).max(8),
  uiMotifs: z.array(z.string().min(1)).max(12),
  notes: z.string().min(1).max(1500),
  suggestedTagIds: z.array(z.string().min(1)).max(24),
  heroPrompt: z.string().max(2000).nullable(),
});

export const itemSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1).max(160),
  notes: z.string().max(4000).default(""),
  sourceUrl: z.string().url().nullable(),
  sourceImageUrl: z.string().url().nullable().optional(),
  sourceDomain: z.string().min(1).max(120).nullable(),
  captureMethod: z.enum(["upload", "url", "drop", "manual"]),
  importedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  media: z
    .object({
      path: z.string().min(1),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      format: z.enum(["webp", "jpeg", "png"]),
    })
    .nullable(),
  manualTagIds: z.array(z.string()).default([]),
  analysis: analysisSchema.nullable().default(null),
  analysisStatus: z.enum(["pending", "ready", "failed", "not-requested"]),
});

export const tagSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const taxonomyGroupSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  tags: z.array(tagSchema),
});

export const taxonomySchema = z.object({
  groups: z.array(taxonomyGroupSchema),
});

export type Analysis = z.infer<typeof analysisSchema>;
export type CatalogItem = z.infer<typeof itemSchema>;
export type Taxonomy = z.infer<typeof taxonomySchema>;

export type CatalogSummary = Pick<
  CatalogItem,
  | "id"
  | "title"
  | "sourceUrl"
  | "sourceDomain"
  | "importedAt"
  | "media"
  | "manualTagIds"
  | "analysis"
  | "analysisStatus"
>;

export type CatalogIndex = {
  generatedAt: string | null;
  items: CatalogSummary[];
};
