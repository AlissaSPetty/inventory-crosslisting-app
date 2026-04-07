import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { INVENTORY_PHOTOS_MAX } from "@inv/shared";
import { apiFetch } from "../lib/api.js";
import { supabase } from "../lib/supabase.js";

/** Placeholder until the user edits the title in the draft editor (API requires a non-empty title). */
const DEFAULT_NEW_INVENTORY_TITLE = "New item";

export function NewDraftPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [files, setFiles] = useState<File[]>([]);

  const previewUrls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);

  useEffect(() => {
    return () => {
      for (const u of previewUrls) URL.revokeObjectURL(u);
    };
  }, [previewUrls]);

  const generate = useMutation({
    mutationFn: async () => {
      const snapshot = files;

      const { item } = (await apiFetch("/api/inventory", {
        method: "POST",
        body: JSON.stringify({ title: DEFAULT_NEW_INVENTORY_TITLE, quantity_available: 1 }),
      })) as { item: { id: string } };

      const uid = (await supabase.auth.getUser()).data.user?.id;
      if (!uid) throw new Error("Not signed in");

      for (let i = 0; i < snapshot.length; i++) {
        const file = snapshot[i];
        const path = `${uid}/${crypto.randomUUID()}-${file.name}`;
        const { error: upErr } = await supabase.storage.from("listing-photos").upload(path, file);
        if (upErr) throw upErr;
        const { error: insErr } = await supabase.from("inventory_images").insert({
          user_id: uid,
          inventory_item_id: item.id,
          storage_path: path,
          sort_order: i,
        });
        if (insErr) throw new Error(insErr.message);
      }

      await apiFetch("/api/ai/generate-drafts-async", {
        method: "POST",
        body: JSON.stringify({ inventory_item_id: item.id }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["listing-drafts"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      navigate("/drafts");
    },
  });

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list?.length) return;
    setFiles((prev) => [...prev, ...Array.from(list)].slice(0, INVENTORY_PHOTOS_MAX));
    e.target.value = "";
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div>
      <p style={{ marginTop: 0 }}>
        <Link to="/drafts">← Listing drafts</Link>
      </p>
      <h1>Add new draft</h1>
      <p style={{ color: "#64748b", fontSize: "0.95rem", marginTop: 0 }}>
        Add up to {INVENTORY_PHOTOS_MAX} photos, then start AI. Drafts show on{" "}
        <Link to="/drafts">Listing drafts</Link> with <strong>Processing</strong> until they’re ready to edit.
      </p>

      <div className="card" style={{ maxWidth: 640 }}>
        <label style={{ display: "block", marginBottom: "0.35rem", fontWeight: 600 }}>Photos (optional)</label>
        <input
          type="file"
          accept="image/*"
          multiple
          disabled={files.length >= INVENTORY_PHOTOS_MAX}
          onChange={onFileChange}
        />
        <p style={{ fontSize: "0.9rem", color: "#64748b", marginTop: "0.35rem", marginBottom: "0.75rem" }}>
          {files.length}/{INVENTORY_PHOTOS_MAX} photos — add images, review thumbnails, remove any you don’t want
          before generating.
        </p>
        {files.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.75rem",
              marginBottom: "1rem",
            }}
          >
            {files.map((f, i) => (
              <div
                key={`${f.name}-${f.size}-${i}`}
                style={{
                  width: 100,
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    width: 100,
                    height: 100,
                    borderRadius: 6,
                    border: "1px solid #e2e8f0",
                    overflow: "hidden",
                    background: "#f1f5f9",
                  }}
                >
                  <img
                    src={previewUrls[i]}
                    alt=""
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      display: "block",
                    }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  style={{
                    marginTop: 6,
                    width: "100%",
                    fontSize: "0.8rem",
                    padding: "0.25rem 0.35rem",
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          className="primary"
          disabled={generate.isPending}
          onClick={() => generate.mutate()}
        >
          {generate.isPending ? "Starting…" : "Generate draft with AI"}
        </button>
        {generate.isError && (
          <p className="error" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
            {(generate.error as Error).message}
          </p>
        )}
      </div>
    </div>
  );
}
