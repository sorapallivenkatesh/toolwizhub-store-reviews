/* config.js — where the frontend finds the API.
   Loaded before app.js so window.TWH exists when the module runs. */
window.TWH = {
  API_BASE: ["localhost", "127.0.0.1"].includes(location.hostname)
    ? "http://localhost:3001"
    : "https://api.store-reviews.toolwizhub.com",
};
