import createLayout from 'justified-layout'

import { profileLibraryLayout, profileThumbnailRenderer } from '../../common/LogConstants'
import { PhotoSectionId, PhotoSectionById, PhotoSection, PhotoType, PhotoId } from '../../common/models/Photo'
import CancelablePromise, { isCancelError } from '../../common/util/CancelablePromise'
import Profiler from '../../common/util/Profiler'
import SerialJobQueue from '../../common/util/SerialJobQueue'

import { fetchSectionPhotos as fetchSectionPhotosFromDb, fetchPhotoDetail } from '../BackgroundClient'
import { GridSectionLayout, GridLayout, JustifiedLayoutBox } from '../UITypes'
import { sectionHeadHeight } from '../components/library/GridSection'
import { forgetSectionPhotosAction, fetchSectionPhotosAction, setLibraryInfoPhotoAction } from '../state/actions'
import store from '../state/store'
import { getThumbnailSrc, createThumbnail as createThumbnailOnDisk } from './ImageProvider'


const pagesToKeep = 4
const pagesToPreload = 3
const averageAspect = 3 / 2
const boxSpacing = 10  // Default 'boxSpacing' of 'justified-layout'

let prevSectionIds: PhotoSectionId[] = []
let prevSectionById: PhotoSectionById = {}
let prevGridLayout: GridLayout = { fromSectionIndex: 0, toSectionIndex: 0, sectionLayouts: [] }
let prevScrollTop = 0
let prevViewportWidth = 0
let prevViewportHeight = 0
let prevGridRowHeight = -1

let isFetchingSectionPhotos = false


export function getGridLayout(sectionIds: PhotoSectionId[], sectionById: PhotoSectionById,
    scrollTop: number, viewportWidth: number, viewportHeight: number, gridRowHeight: number, nailedSectionIndex: number | null):
    GridLayout
{
    const profiler = profileLibraryLayout ? new Profiler(`Calculating layout for ${sectionIds.length} sections`) : null

    let sectionsChanged = false
    let fromSectionIndex: number | null = null
    let toSectionIndex: number | null = null
    let sectionLayouts: GridSectionLayout[] = []
    const prevLayoutIsDirty = (viewportWidth !== prevViewportWidth) || (gridRowHeight !== prevGridRowHeight)

    let inDomMinY: number | null = null
    let inDomMaxY: number | null = null
    if (nailedSectionIndex === null) {
        inDomMinY = scrollTop - pagesToPreload * viewportHeight
        inDomMaxY = scrollTop + (pagesToPreload + 1) * viewportHeight
    }

    let sectionTop = 0
    const sectionCount = sectionIds.length
    for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
        const sectionId = sectionIds[sectionIndex]
        const section = sectionById[sectionId]

        const usePlaceholder = !section.photoIds
        const prevLayout = (
                !prevLayoutIsDirty
                && section === prevSectionById[prevSectionIds[sectionIndex]]
                    // We have to compare sections, not section IDs in order to detect changes inside the section.
                    // See `createLayoutForLoadedSection`
            ) ? prevGridLayout.sectionLayouts[sectionIndex] : null

        let layout: GridSectionLayout
        if (prevLayout) {
            const prevLayoutIsPlaceholder = !prevLayout.boxes
            if (usePlaceholder == prevLayoutIsPlaceholder) {
                layout = prevLayout
            }
        }

        if (layout) {
            if (layout.sectionTop !== sectionTop) {
                layout.sectionTop = sectionTop
                sectionsChanged = true
            }
        } else {
            sectionsChanged = true
            // We have to update the layout
            if (usePlaceholder) {
                if (prevLayout) {
                    // Section data was dropped -> Drop layout boxes as well
                    layout = { sectionTop, containerHeight: prevLayout.containerHeight }
                } else {
                    layout = { sectionTop, containerHeight: estimateContainerHeight(viewportWidth, gridRowHeight, section.count) }
                }
            } else {
                // Calculate boxes
                layout = createLayoutForLoadedSection(section, sectionTop, viewportWidth, gridRowHeight)
            }
        }


        if (sectionIndex === nailedSectionIndex) {
            inDomMinY = sectionTop
            inDomMaxY = sectionTop + viewportHeight
        }

        const sectionHeight = sectionHeadHeight + layout.containerHeight
        const sectionBottom = sectionTop + sectionHeight
        const showSectionInDom = inDomMinY !== null && sectionBottom >= inDomMinY && sectionTop <= inDomMaxY
        if (showSectionInDom) {
            if (fromSectionIndex === null) {
                fromSectionIndex = sectionIndex
            }

            if (!layout.boxes) {
                // Section is not loaded yet, but will be shown in DOM -> Create dummy boxes
                layout.boxes = createDummyLayoutBoxes(viewportWidth, gridRowHeight, layout.containerHeight, section.count)
            }

            const prevFromBoxIndex = layout.fromBoxIndex
            const prevToBoxIndex = layout.toBoxIndex
            layout.fromBoxIndex = 0
            layout.toBoxIndex = section.count
            if (sectionTop < inDomMinY || sectionBottom > inDomMaxY) {
                // This section is party visible -> Go throw the boxes and find the correct boundaries
                const boxes = layout.boxes
                const boxCount = boxes.length

                let searchingStart = true
                for (let boxIndex = 0; boxIndex < boxCount; boxIndex++) {
                    const box = boxes[boxIndex]
                    const boxTop = sectionTop + sectionHeadHeight + box.top
                    const boxBottom = boxTop + box.height
                    if (searchingStart) {
                        if (boxBottom >= inDomMinY) {
                            layout.fromBoxIndex = boxIndex
                            searchingStart = false
                        }
                    } else if (boxTop > inDomMaxY) {
                        layout.toBoxIndex = boxIndex
                        break
                    }
                }
            }
            if (layout.fromBoxIndex !== prevFromBoxIndex || layout.toBoxIndex !== prevToBoxIndex) {
                sectionsChanged = true
            }
        } else { // isSectionVisible == false
            if (toSectionIndex === null && fromSectionIndex !== null) {
                toSectionIndex = sectionIndex
            }
            if (layout.boxes) {
                // This section is fully invisible -> Keep the layout but add no photos to the DOM
                layout.fromBoxIndex = null
                layout.toBoxIndex = null
            }
        }

        sectionLayouts.push(layout)

        // Prepare next iteration
        sectionTop = sectionBottom
    }

    if (toSectionIndex === null) {
        toSectionIndex = sectionCount
    }

    const viewportTop = (nailedSectionIndex === null) ? scrollTop : sectionLayouts[nailedSectionIndex].sectionTop
    forgetAndFetchSections(sectionIds, sectionById, viewportTop, viewportHeight, sectionLayouts)

    if (profiler) {
        profiler.addPoint('Calculated layout')
        profiler.logResult()
    }

    let nextGridLayout: GridLayout
    if (sectionsChanged
        || fromSectionIndex !== prevGridLayout.fromSectionIndex
        || toSectionIndex !== prevGridLayout.toSectionIndex)
    {
        nextGridLayout = { fromSectionIndex, toSectionIndex, sectionLayouts }
    } else {
        nextGridLayout = prevGridLayout
    }

    prevSectionIds = sectionIds
    prevSectionById = sectionById
    prevGridLayout = nextGridLayout
    prevScrollTop = scrollTop
    prevViewportWidth = viewportWidth
    prevViewportHeight = viewportHeight
    prevGridRowHeight = gridRowHeight

    return nextGridLayout
}


export function createLayoutForLoadedSection(section: PhotoSection, sectionTop: number, containerWidth: number, targetRowHeight: number): GridSectionLayout {
    const aspects = section.photoIds.map(photoId => {
        const photo = section.photoData[photoId]
        const { master_width, master_height } = photo
        // If we have no master size yet (which happens when loading an old DB were it was missing), the following will happen:
        //   - We calculate a layout using the average aspect (which is how the loading rect of the photo is shown)
        //   - `ThumbnailRenderer.renderThumbnailForPhoto` will detect that the master size is missing and will update the DB
        //   - The Grid will trigger a layout, because the photo has changed in the app state
        //   - `getLayoutForSections` will detect that the section changed and so it will get a ney layout using the correct master size
        return (master_width && master_height) ? (master_width / master_height) : averageAspect
    })
    const layout = createLayout(aspects, { containerWidth, targetRowHeight })
    layout.sectionTop = sectionTop
    layout.containerHeight = Math.round(layout.containerHeight)
    return layout
}


export function estimateContainerHeight(viewportWidth: number, gridRowHeight: number, photoCount: number): number {
    if (viewportWidth === 0) {
        return boxSpacing + photoCount * (gridRowHeight + boxSpacing)
    } else {
        // Estimate section height (assuming a normal landscape aspect ratio of 3:2)
        const unwrappedWidth = averageAspect * photoCount * gridRowHeight
        const rows = Math.ceil(unwrappedWidth / viewportWidth)
        return rows * gridRowHeight + (rows + 1) * boxSpacing
    }
}

export function createDummyLayoutBoxes(viewportWidth: number, gridRowHeight: number, containerHeight: number, photoCount: number): JustifiedLayoutBox[] {
    const rowCount = Math.round((containerHeight - boxSpacing) / (gridRowHeight + boxSpacing))   // Reverse `estimateContainerHeight`
    let boxes: JustifiedLayoutBox[] = []
    for (let row = 0; row < rowCount; row++) {
        const lastBoxIndex = Math.ceil(photoCount * (row + 1) / rowCount)  // index is excluding
        const colCount = lastBoxIndex - boxes.length
        let boxWidth = (viewportWidth - (colCount + 1) * boxSpacing) / colCount
        if (row === rowCount - 1) {
            boxWidth = Math.min(boxWidth, averageAspect * gridRowHeight)
        }
        const aspectRatio = boxWidth / gridRowHeight
    
        for (let col = 0; col < colCount; col++) {
            if (boxes.length >= photoCount) {
                break
            }
            boxes.push({
                aspectRatio,
                left: col * boxWidth + (col + 1) * boxSpacing,
                top: boxSpacing + row * (gridRowHeight + boxSpacing),
                width: boxWidth,
                height: gridRowHeight
            })
        }
    }
    return boxes
}


/** Determines which sections we have to load or forget */
function forgetAndFetchSections(sectionIds: PhotoSectionId[], sectionById: PhotoSectionById,
    viewportTop: number, viewportHeight: number, sectionLayouts: GridSectionLayout[])
{
    let sectionIdsToProtect: { [index: string]: true }
    let sectionIdsToForget: { [index: string]: true } = null
    let sectionIdToLoad: PhotoSectionId | null = null
    let sectionIdToLoadDistance = Number.POSITIVE_INFINITY

    const isScrollingDown = (viewportTop >= prevScrollTop)
    const keepMinY = viewportTop - pagesToKeep * viewportHeight
    const keepMaxY = viewportTop + (pagesToKeep + 1) * viewportHeight
    const preloadMinY = viewportTop - (isScrollingDown ? 0 : pagesToPreload) * viewportHeight
    const preloadMaxY = viewportTop + ((isScrollingDown ? pagesToPreload : 0) + 1) * viewportHeight

    for (let sectionIndex = 0, sectionCount = sectionIds.length; sectionIndex < sectionCount; sectionIndex++) {
        const sectionId = sectionIds[sectionIndex]
        const section = sectionById[sectionId]
        const layout = sectionLayouts[sectionIndex]

        const sectionTop = layout.sectionTop
        const sectionBottom = sectionTop + sectionHeadHeight + layout.containerHeight
        if (section.photoIds) {
            const keepSection = sectionBottom > keepMinY && sectionTop < keepMaxY
            if (!keepSection) {
                if (!sectionIdsToProtect) {
                    sectionIdsToProtect = getSectionIdsToProtect()
                }

                if (!sectionIdsToProtect[sectionId]) {
                    if (!sectionIdsToForget) {
                        sectionIdsToForget = {}
                    }
                    sectionIdsToForget[sectionId] = true
                }
            }
        } else if (!isFetchingSectionPhotos) {
            const loadSection = sectionBottom > preloadMinY && sectionTop < preloadMaxY
            if (loadSection) {
                let distanceToViewPort = 0
                if (sectionBottom < viewportTop) {
                    distanceToViewPort = viewportTop - sectionBottom
                } else if (sectionTop > viewportTop + viewportHeight) {
                    distanceToViewPort = sectionTop - (viewportTop + viewportHeight)
                }

                if (distanceToViewPort < sectionIdToLoadDistance) {
                    sectionIdToLoad = sectionId
                    sectionIdToLoadDistance = distanceToViewPort
                }
            }
        }
    }

    if (sectionIdsToForget) {
        setTimeout(() => store.dispatch(forgetSectionPhotosAction(sectionIdsToForget)))
    }
    if (sectionIdToLoad) {
        fetchSectionPhotos(sectionIdToLoad)
    }
}


function getSectionIdsToProtect(): { [index: string]: true } {
    const state = store.getState()
    let sectionsToProtect = {}

    const selectedSectionId = state.library.selection.sectionId
    if (selectedSectionId) {
        sectionsToProtect[selectedSectionId] = true
    }

    if (state.library.info) {
        sectionsToProtect[state.library.info.sectionId] = true
    }

    if (state.detail) {
        sectionsToProtect[state.detail.currentPhoto.sectionId] = true
    }

    if (state.export) {
        sectionsToProtect[state.export.sectionId] = true
    }

    return sectionsToProtect
}


function fetchSectionPhotos(sectionId: PhotoSectionId) {
    if (isFetchingSectionPhotos) {
        return
    }

    const filter = store.getState().library.filter

    isFetchingSectionPhotos = true
    fetchSectionPhotosFromDb(sectionId, filter)
        .then(photos => {
            isFetchingSectionPhotos = false
            store.dispatch(fetchSectionPhotosAction(sectionId, photos))
        })
        .catch(error => {
            isFetchingSectionPhotos = false
            // TODO: Show error in UI
            console.error(`Fetching photos for section ${sectionId} failed`, error)
        })
}


let runningInfoPhotoDetailPromise: CancelablePromise<void> | null = null

export function setInfoPhoto(sectionId: PhotoSectionId | null, photoId: PhotoId | null) {
    store.dispatch(setLibraryInfoPhotoAction.request({ sectionId, photoId }))
    if (runningInfoPhotoDetailPromise) {
        runningInfoPhotoDetailPromise.cancel()
        runningInfoPhotoDetailPromise = null
    }

    if (photoId) {
        runningInfoPhotoDetailPromise = new CancelablePromise(fetchPhotoDetail(photoId))
            .then(photoDetail => store.dispatch(setLibraryInfoPhotoAction.success({ photoDetail })))
            .catch(error => {
                if (!isCancelError(error)) {
                    store.dispatch(setLibraryInfoPhotoAction.failure(error))
                    // TODO: Show error in UI
                    console.error('Fetching photo detail failed', error)
                }
            })
    }
}


type CreateThumbnailJob = { isCancelled: boolean, sectionId: PhotoSectionId, photo: PhotoType, profiler: Profiler }

const createThumbnailQueue = new SerialJobQueue(
    (newJob, existingJob) => (newJob.photo.id === existingJob.photo.id) ? newJob : null,
    createNextThumbnail,
    getThumbnailPriority)

export function createThumbnail(sectionId: PhotoSectionId, photo: PhotoType): CancelablePromise<string> {
    const profiler = profileThumbnailRenderer ? new Profiler(`Creating thumbnail for ${photo.master}`) : null

    const job: CreateThumbnailJob = { isCancelled: false, sectionId, photo, profiler }

    return new CancelablePromise<string>(
        createThumbnailQueue.addJob(job)
            .then(() => {
                if (profiler) profiler.logResult()
                return getThumbnailSrc(photo)
            })
    )
    .catch(error => {
        if (isCancelError(error)) {
            job.isCancelled = true
        }
        throw error
    })
}

async function createNextThumbnail(job: CreateThumbnailJob): Promise<void> {
    if (job.isCancelled) {
        return
    }

    await createThumbnailOnDisk(job.photo, job.profiler)
}

function getThumbnailPriority(job: CreateThumbnailJob): number {
    const { sectionId, photo } = job
    const sectionIndex = prevSectionIds.indexOf(sectionId)
    const section = prevSectionById[sectionId]
    const layout = prevGridLayout.sectionLayouts[sectionIndex]
    if (!section || !layout || !layout.boxes) {
        return Number.MIN_VALUE
    }

    const photoIndex = section.photoIds.indexOf(photo.id)
    const box = layout.boxes[photoIndex]
    if (!box) {
        return Number.MIN_VALUE
    }

    const boxTop = layout.sectionTop + sectionHeadHeight + box.top
    const scrollBottom = prevScrollTop + prevViewportHeight
    if (boxTop > scrollBottom) {
        // Box is below viewport -> Use a negative prio reflecting the distance
        return scrollBottom - boxTop
    }

    const boxBottom = boxTop + box.height
    if (boxBottom < prevScrollTop) {
        // Box is above viewport -> Use a negative prio reflecting the distance
        return boxBottom - prevScrollTop
    }

    // Box is visible -> Use a positive prio reflecting position (images should appear in reading order)
    const prio = (scrollBottom - boxTop) + (prevViewportWidth - box.left) / prevViewportWidth
    return prio
}
