export function HybridPage() {
  return (
    <div>
      <h1>Poshmark & Mercari</h1>
      <div className="card">
        <p>
          Hybrid mode: create drafts in <strong>Inventory</strong>, add platform listing URL / ID under
          platform listings, and complete publish/delete steps on each marketplace when automation is not
          available.
        </p>
        <ol>
          <li>Create an inventory item and optional AI drafts.</li>
          <li>Add a manual platform listing row linking to the item (API: POST /api/platform-listings).</li>
          <li>Use the marketplace app to publish; keep URLs in sync here.</li>
        </ol>
      </div>
    </div>
  );
}
