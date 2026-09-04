function ok(response, data = {}, status = 200) { return response.status(status).json({ success: true, data, ...data }); }
function fail(response, status, message) { return response.status(status).json({ success: false, error: { message }, message }); }
module.exports = { ok, fail };
