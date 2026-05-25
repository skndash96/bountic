diff --git a/src/routes/store/cart.ts b/src/routes/store/cart.ts
index abc1234..def5678 100644
--- a/src/routes/store/cart.ts
+++ b/src/routes/store/cart.ts
@@ -10,6 +10,7 @@ export async function getCart(id: string) {
     method: 'GET',
     query: {
       fields: '*items, *region, *items.product, *items.variant, +items.variant.inventory_quantity, *items.thumbnail, *items.metadata, +items.total, *promotions, +shipping_methods.name'
+      // Additional changes to include inventory quantity
     }
   });
   return response.data;
}