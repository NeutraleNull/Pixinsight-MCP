const views = [ ...new Set( typeof args.view == "string" ? [ args.view ] : args.view ) ].map( id => ctx.view( id ) );

// Everything is checked first, so that a refusal leaves all images open.
for ( const view of views )
   if ( !view.isMainView )
      ctx.fail( "not_supported", view.fullId + " is a preview. Use delete_preview, or close its image." );

// With several images, a plain "discard" would also cover work the caller knows nothing about,
// such as a change the user made in the meantime. So the images to discard have to be named.
const discard = args.discardChanges;
if ( discard === true && views.length > 1 )
   ctx.fail( "invalid_arguments", "With several images, name those whose unsaved work may be lost: discardChanges: [\"" + views[0].id + "\", ...]." );
const mayDiscard = view => discard === true || (Array.isArray( discard ) && discard.includes( view.id ));

// close() would open a modal question for a modified image and block the job queue behind it.
const unsaved = views.filter( view => ctx.isUnsaved( view.window ) );
const refused = unsaved.filter( view => !mayDiscard( view ) ).map( view => view.id );
if ( refused.length > 0 )
   ctx.fail( "unsaved_changes", refused.join( ", " ) + " holds unsaved work, so nothing was closed. Save it, or name it in discardChanges if it is your own temporary image or the user has agreed." );

// Everything the result names is read now: a closed window has no identifier any more.
const ids = views.map( view => view.window.mainView.id );
const discarded = unsaved.map( view => view.id );
let previews = 0;
for ( const view of views )
   previews += view.window.previews.length;
// An image whose mask gets closed keeps working, but without the protection anyone asked for.
const maskOf = [ ...new Set( views.flatMap( view => ctx.maskedBy( view.window ) ) ) ].filter( id => !ids.includes( id ) );

for ( const view of views )
   view.window.forceClose();

const result = { closed: ids };
if ( discarded.length > 0 )
   result.discarded = discarded;
if ( previews > 0 )
   result.closedPreviews = previews;
if ( maskOf.length > 0 )
   result.removedAsMaskFrom = maskOf;
return result;
