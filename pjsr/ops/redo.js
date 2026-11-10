const view = ctx.view( args.view );
if ( !view.canGoForward )
   ctx.fail( "nothing_to_redo", view.fullId + " has no later state." );

// The caller wants to move from the state its own step left. If the history has moved since,
// for example by a step of the user, this would take back the wrong thing.
if ( args.historyIndex !== undefined && args.historyIndex != view.historyIndex )
   ctx.fail( "history_changed", view.fullId + " is at history state " + view.historyIndex + ", not " + args.historyIndex + ": something else has changed it since. Look at the image before you go on." );

let warning = null;
for ( let i = args.count || 1; i > 0 && view.canGoForward; --i )
   warning = ctx.moveInHistory( view, view.historyIndex + 1 ) || warning;

const result = { view: view.fullId, historyIndex: view.historyIndex, canUndo: view.canGoBackward, canRedo: view.canGoForward };
if ( warning )
   result.warning = warning;
return result;
