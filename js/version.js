/* Single source of truth for the tool version.

   Bump on release. It labels the page header AND versions every data and
   asset request, so an updated deploy cannot be served stale data from a
   browser cache. Keep index.html's ?v= query in step. */
export const APP_VERSION = "1.14.3";
