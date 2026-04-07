type ShopifyCreds = {
  accessToken: string;
  shopDomain: string;
};

export async function publishToShopify(
  creds: ShopifyCreds,
  input: { title: string; bodyHtml: string; price: number; quantity: number }
): Promise<{ productId: string; adminUrl: string }> {
  const domain = creds.shopDomain;
  const url = `https://${domain}/admin/api/2024-01/products.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": creds.accessToken,
    },
    body: JSON.stringify({
      product: {
        title: input.title,
        body_html: input.bodyHtml,
        variants: [
          {
            price: input.price.toFixed(2),
            inventory_management: "shopify",
            inventory_quantity: input.quantity,
          },
        ],
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Shopify product create: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    product: { id: number; title: string };
  };
  const id = String(data.product?.id ?? "");
  const adminUrl = `https://${domain}/admin/products/${id}`;
  return { productId: id, adminUrl };
}
