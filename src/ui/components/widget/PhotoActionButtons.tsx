import classNames from 'classnames'
import React from 'react'
import { MdRotateLeft, MdRotateRight } from 'react-icons/md'
import { Button, ButtonGroup, Classes } from '@blueprintjs/core'

import { PhotoId, PhotoType, PhotoWork, PhotoSectionId } from '../../../common/models/Photo'
import { rotate } from '../../../common/util/EffectsUtil'
import { bindMany } from '../../../common/util/LangUtil'

import toaster from '../../Toaster'
import FaIcon from './icon/FaIcon'
import { SVG_ICON_CLASS } from './icon/SvgIcon'
import MdRestoreFromTrash from './icon/MdRestoreFromTrash'

import './PhotoActionButtons.less'


interface Props {
    selectedSectionId: PhotoSectionId,
    selectedPhotos: PhotoType[]
    isShowingTrash: boolean
    isShowingInfo: boolean
    openExport: (sectionId: PhotoSectionId, photoIds: PhotoId[]) => void
    updatePhotoWork: (photo: PhotoType, update: (photoWork: PhotoWork) => void) => void
    setPhotosFlagged: (photos: PhotoType[], flag: boolean) => void
    movePhotosToTrash: (photos: PhotoType[]) => void
    restorePhotosFromTrash: (photos: PhotoType[]) => void
    toggleShowInfo: () => void
}

export default class PhotoActionButtons extends React.Component<Props> {

    constructor(props: Props) {
        super(props)

        bindMany(this, 'rotateLeft', 'rotateRight', 'toggleFlagged', 'moveToTrash', 'restoreFromTrash', 'openExport')
    }

    rotateLeft() {
        this.rotate(-1)
    }

    rotateRight() {
        this.rotate(1)
    }

    rotate(turns: number) {
        const props = this.props
        for (const photo of props.selectedPhotos) {
            props.updatePhotoWork(photo, photoWorks => rotate(photoWorks, turns))
        }
    }

    toggleFlagged() {
        const props = this.props
        const newFlagged = !this.getSelectedAreFlagged()

        let photosToChange = []
        for (const photo of props.selectedPhotos) {
            if (!!photo.flag !== newFlagged) {
                photosToChange.push(photo)
            }
        }

        this.props.setPhotosFlagged(photosToChange, newFlagged)
    }

    getSelectedAreFlagged() {
        const props = this.props
        if (!props.selectedSectionId || props.selectedPhotos.length === 0) {
            return false
        } else {
            for (const photo of props.selectedPhotos) {
                if (!photo.flag) {
                    return false
                }
            }
            return true
        }
    }

    moveToTrash() {
        const selectedPhotos = this.props.selectedPhotos
        this.props.movePhotosToTrash(selectedPhotos)
        toaster.show({
            icon: 'tick',
            message: selectedPhotos.length === 1 ? 'Moved photo to trash' : `Moved ${selectedPhotos.length} photos to trash`,
            intent: 'success'
        })
    }

    restoreFromTrash() {
        const selectedPhotos = this.props.selectedPhotos
        this.props.restorePhotosFromTrash(selectedPhotos)
        toaster.show({
            icon: 'tick',
            message: selectedPhotos.length === 1 ? 'Restored photo from trash' : `Restored ${selectedPhotos.length} photos from trash`,
            intent: 'success'
        })
    }

    openExport() {
        const props = this.props
        const selectedPhotoIds = props.selectedPhotos.map(photo => photo.id)
        props.openExport(props.selectedSectionId, selectedPhotoIds)
    }

    render() {
        const props = this.props
        const hasSelection = props.selectedPhotos.length > 0
        const selectedAreFlagged = this.getSelectedAreFlagged()
        return (
            <>
                <ButtonGroup>
                    <Button minimal={true} disabled={!hasSelection} onClick={this.rotateLeft} title="Rotate left">
                        <MdRotateLeft className={SVG_ICON_CLASS}/>
                    </Button>
                    <Button minimal={true} disabled={!hasSelection} onClick={this.rotateRight} title="Rotate right">
                        <MdRotateRight className={SVG_ICON_CLASS}/>
                    </Button>
                </ButtonGroup>
                <Button
                    className={classNames('PhotoActionButtons-flagButton', { isActive: selectedAreFlagged })}
                    minimal={true}
                    active={selectedAreFlagged}
                    disabled={!hasSelection}
                    onClick={this.toggleFlagged}
                    title={selectedAreFlagged ? 'Remove flag' : 'Flag'}
                >
                    <FaIcon name="flag" />
                </Button>
                {!props.isShowingTrash &&
                    <Button minimal={true} icon="trash" disabled={!hasSelection} onClick={this.moveToTrash} title="Move photo to trash"/>
                }
                {props.isShowingTrash &&
                    <Button
                        disabled={!hasSelection}
                        intent={hasSelection ? 'success' : null}
                        title="Restore photo from trash"
                        onClick={this.restoreFromTrash}
                    >
                        <MdRestoreFromTrash/>
                        <span className={Classes.BUTTON_TEXT}>Restore</span>
                    </Button>
                }
                <Button
                    minimal={true}
                    icon="info-sign"
                    title={props.isShowingInfo ? "Hide photo info" : "Show photo info"}
                    active={props.isShowingInfo}
                    disabled={!hasSelection && !props.isShowingInfo}
                    onClick={this.props.toggleShowInfo}
                />
                <Button minimal={true} icon="export" disabled={!hasSelection} onClick={this.openExport} title="Export"/>
            </>
        )    
    }
}
