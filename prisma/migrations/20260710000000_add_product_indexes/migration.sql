-- CreateIndex: speed up category filter in fetchDeals and related product queries
CREATE INDEX "Product_category_idx" ON "Product"("category");

-- CreateIndex: speed up order-by-popularity in related products sidebar
CREATE INDEX "Product_queries_idx" ON "Product"("queries");
