// The order page exists only while site.json's orderForm is on: off, it has no URL, so nothing is written
// and the sitemap skips it.
module.exports = {
  eleventyComputed: {
    permalink: (data) => (data.site.orderForm ? "/order/" : false),
  },
};
