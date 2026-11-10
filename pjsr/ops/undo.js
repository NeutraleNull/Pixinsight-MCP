const view = ctx.view( args.view );
if ( !view.canGoBackward )
   ctx.fail( "nothing_to_undo", view.fullId + " has no earlier state." );

// The caller wants to move from the state its own step left. If the history has moved since,
// for example by a step of the user, this would take back the wrong thing.
if ( args.historyIndex !== undefined && args.historyIndex != view.historyIndex )
   ctx.fail( "history_changed", view.fullId + " is at history state " + view.historyIndex + ", not " + args.historyIndex + ": something else has changed it since. Look at the image before you go on." );

// Works for previews too, and unlike ImageWindow.undo() needs no change of the current view.
const warning = ctx.moveInHistory( view, Math.max( 0, view.historyIndex - (args.count || 1) ) );

const result = { view: view.fullId, historyIndex: view.historyIndex, canUndo: view.canGoBackward, canRedo: view.canGoForward };
if ( warning )
   result.warning = warning;
return result;
