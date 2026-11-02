/**
 * Совместимость: API уже объявлен в utils.js (attachDiagnostics / mountDiagramCanvas / …).
 * Файл оставлен в бандле, чтобы старые закладки/кэш со скриптом не давали 404.
 * @deprecated логика в js/utils.js
 */
(function () {
    if (typeof mountDiagramCanvas === 'function') return;
    console.warn('[diagrams] mountDiagramCanvas отсутствует — обновите utils.js');
})();
