const active = ImageWindow.activeWindow;
const activeId = (active && !active.isNull) ? active.mainView.id : null;

return ImageWindow.windows.map( w =>
{
   const image = w.mainView.image;
   const result = {
      view: w.mainView.id,
      active: w.mainView.id == activeId,
      filePath: w.filePath,
      modified: w.isModified,
      // Closing this image would lose work. Also true for new images that were never saved.
      unsaved: ctx.isUnsaved( w ),
      // Also false for windows on another workspace, so it does not mean "hidden".
      visible: w.visible,
      iconic: w.iconic,
      width: image.width,
      height: image.height,
      channels: image.numberOfChannels,
      color: image.isColor,
      bitsPerSample: w.bitsPerSample,
      floatSample: w.isFloatSample,
      astrometry: w.hasAstrometricSolution,
      previews: w.previews.map( p => p.fullId ),
      canUndo: w.mainView.canGoBackward,
      canRedo: w.mainView.canGoForward
   };
   if ( !w.mask.isNull )
      result.mask = { view: w.mask.mainView.id, enabled: w.maskEnabled, inverted: w.maskInverted };
   const source = ctx.sourcePath( w );
   if ( source !== null )
      result.sourcePath = source;
   return result;
} );
