package server

import "net/http"

// ipamOverlaps serves the Network page's "Overlapping ranges" card: address
// ranges used in more than one IP space. The read and the grouping live in
// dashboard.FetchOverlaps, which the AI tool get_overlapping_ranges calls too.
// A read that could not be shown to be whole answers status:"error" with a
// plain sentence and no groups, never a partial list.
func (d *Deps) ipamOverlaps(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/ipam/overlaps")
	d.json(w, r, 200, d.dash(r).FetchOverlaps())
}
