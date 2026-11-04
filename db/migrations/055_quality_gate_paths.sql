-- protectedGatePaths stays inside the immutable quality policy snapshot.
-- When the field is absent, the historical snapshot and its digest are unchanged.
COMMENT ON TABLE ac_quality_policies IS
 'Immutable quality policy revisions. Optional snapshot field protectedGatePaths lists at most 64 normalized relative gate paths (exact file or directory prefix ending in /). The policy digest covers the field only when it is present.';
