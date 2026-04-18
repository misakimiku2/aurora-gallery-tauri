import { convertFileSrc } from '@tauri-apps/api/core';
import { AppState, Person, AiFace, FileType, TabState, PersonSortOption, SortDirection } from '../types';
import { dbUpsertPerson, dbDeletePerson, dbUpsertFileMetadata } from '../api/tauri-bridge';

interface UsePeopleProps {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  activeTab: TabState;
  t: (key: string) => string;
  showToast: (msg: string) => void;
  peopleWithDisplayCounts: Record<string, Person>;
  personSortBy: PersonSortOption;
  personSortDirection: SortDirection;
  isSelecting: boolean;
  closeContextMenu: () => void;
  updateActiveTab: (updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => void;
  enterPeopleOverview: () => void;
}

export const usePeople = ({
  state,
  setState,
  activeTab,
  t,
  showToast,
  peopleWithDisplayCounts,
  personSortBy,
  personSortDirection,
  isSelecting,
  closeContextMenu,
  updateActiveTab,
  enterPeopleOverview,
}: UsePeopleProps) => {

  const handlePersonClick = (personId: string, e: React.MouseEvent) => {
    e.stopPropagation();

    closeContextMenu();

    if (isSelecting) return;

    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    let newSelectedPersonIds: string[];
    let newLastSelectedId: string = personId;

    let allPeople = Object.values(peopleWithDisplayCounts);

    if (activeTab.searchQuery && activeTab.searchQuery.trim()) {
      const query = activeTab.searchQuery.toLowerCase().trim();
      allPeople = allPeople.filter(person =>
        person.name.toLowerCase().includes(query)
      );
    }

    allPeople.sort((a, b) => {
      let comparison = 0;

      switch (personSortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name, 'zh-CN');
          break;
        case 'count':
          comparison = a.count - b.count;
          break;
        case 'created':
          const fileA = state.files[a.coverFileId];
          const fileB = state.files[b.coverFileId];
          const dateA = fileA?.meta?.created ? new Date(fileA.meta.created).getTime() : 0;
          const dateB = fileB?.meta?.created ? new Date(fileB.meta.created).getTime() : 0;
          comparison = dateA - dateB;
          break;
        default:
          comparison = a.count - b.count;
      }

      return personSortDirection === 'asc' ? comparison : -comparison;
    });

    const allPersonIds = allPeople.map(person => person.id);

    if (isCtrl) {
      if (activeTab.selectedPersonIds.includes(personId)) {
        newSelectedPersonIds = activeTab.selectedPersonIds.filter(id => id !== personId);
      } else {
        newSelectedPersonIds = [...activeTab.selectedPersonIds, personId];
      }
      newLastSelectedId = personId;
    } else if (isShift) {
      let lastSelectedId = activeTab.lastSelectedId;

      if (!lastSelectedId) {
        lastSelectedId = activeTab.selectedPersonIds.length > 0 ? activeTab.selectedPersonIds[0] : personId;
      }

      const lastIndex = allPersonIds.indexOf(lastSelectedId);
      const currentIndex = allPersonIds.indexOf(personId);

      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        newSelectedPersonIds = allPersonIds.slice(start, end + 1);
      } else {
        newSelectedPersonIds = [personId];
      }
    } else {
      newSelectedPersonIds = [personId];
    }

    updateActiveTab({
      selectedPersonIds: newSelectedPersonIds,
      lastSelectedId: newLastSelectedId
    });
  };

  const handleRenamePerson = (personId: string, newName: string) => {
    if (!newName.trim()) return;
    setState(prev => {
      const updatedPerson = { ...prev.people[personId], name: newName };
      dbUpsertPerson(updatedPerson).catch(e => console.error("Failed to update person name in DB", e));

      return {
        ...prev,
        people: {
          ...prev.people,
          [personId]: updatedPerson
        },
        activeModal: { type: null }
      };
    });
  };

  const handleUpdatePerson = (personId: string, updates: Partial<Person>) => {
    setState(prev => {
      const updatedPerson = { ...prev.people[personId], ...updates };
      dbUpsertPerson(updatedPerson).catch(e => console.error("Failed to update person in DB", e));

      return {
        ...prev,
        people: {
          ...prev.people,
          [personId]: updatedPerson
        }
      };
    });
  };

  const handleCreatePerson = () => {
    setState(prev => ({
      ...prev,
      activeModal: { type: 'create-person', data: {} }
    }));

    enterPeopleOverview();
  };

  const handleConfirmCreatePerson = (name: string) => {
    const newId = Math.random().toString(36).substr(2, 9);
    const newPerson: Person = {
      id: newId,
      name: name || t('context.newPersonDefault'),
      coverFileId: '',
      count: 0,
      description: ''
    };

    dbUpsertPerson(newPerson).catch(e => console.error("Failed to create person in DB", e));

    setState(prev => ({
      ...prev,
      people: { ...prev.people, [newId]: newPerson },
      activeModal: { type: null }
    }));
  };

  const handleSmartCreatePerson = async (
    name: string,
    coverFileId: string,
    matchedFileIds: string[],
    faceBox?: { x: number; y: number; w: number; h: number },
    characterTagName?: string,
    characterTagIndex?: number
  ) => {
    const newId = Math.random().toString(36).substr(2, 9);
    const newPerson: Person = {
      id: newId,
      name,
      coverFileId,
      count: matchedFileIds.length,
      description: '',
      faceBox,
      characterTagName,
      characterTagIndex
    };

    await dbUpsertPerson(newPerson).catch(e => console.error("Failed to create person in DB", e));

    setState(prev => {
      const newFiles = { ...prev.files };

      matchedFileIds.forEach(fid => {
        const file = newFiles[fid];
        if (file && file.type === FileType.IMAGE) {
          const currentFaces = file.aiData?.faces || [];
          const newFace: AiFace = {
            id: Math.random().toString(36).substr(2, 9),
            personId: newId,
            name: name,
            confidence: 1.0,
            box: { x: 0, y: 0, w: 0, h: 0 }
          };
          const newAiData = file.aiData
            ? { ...file.aiData, faces: [...currentFaces, newFace] }
            : {
                analyzed: false,
                analyzedAt: new Date().toISOString(),
                description: '',
                tags: [],
                faces: [newFace],
                sceneCategory: '',
                confidence: 1.0,
                dominantColors: [],
                objects: []
              };
          newFiles[fid] = { ...file, aiData: newAiData };
        }
      });

      matchedFileIds.forEach(fid => {
        const file = newFiles[fid];
        if (file && file.aiData) {
          dbUpsertFileMetadata({
            fileId: fid,
            path: file.path,
            tags: file.tags,
            description: file.description,
            sourceUrl: file.sourceUrl,
            category: file.category,
            aiData: file.aiData,
            updatedAt: Date.now()
          }).catch(err => console.error('Failed to persist file aiData:', err));
        }
      });

      return {
        ...prev,
        people: { ...prev.people, [newId]: newPerson },
        files: newFiles
      };
    });

    enterPeopleOverview();
  };

  const handleSmartAddToPerson = (personId: string, newFileIds: string[]) => {
    const person = state.people[personId];
    if (!person) return;

    setState(prev => {
      const newFiles = { ...prev.files };
      let addedCount = 0;

      newFileIds.forEach(fid => {
        const file = newFiles[fid];
        if (file && file.type === FileType.IMAGE) {
          const currentFaces = file.aiData?.faces || [];
          if (!currentFaces.some(f => f.personId === personId)) {
            const newFace: AiFace = {
              id: Math.random().toString(36).substr(2, 9),
              personId: personId,
              name: person.name,
              confidence: 1.0,
              box: { x: 0, y: 0, w: 0, h: 0 }
            };
            const newAiData = file.aiData
              ? { ...file.aiData, faces: [...currentFaces, newFace] }
              : {
                  analyzed: false,
                  analyzedAt: new Date().toISOString(),
                  description: '',
                  tags: [],
                  faces: [newFace],
                  sceneCategory: '',
                  confidence: 1.0,
                  dominantColors: [],
                  objects: []
                };
            newFiles[fid] = { ...file, aiData: newAiData };
            addedCount++;
          }
        }
      });

      if (addedCount > 0) {
        const updatedPerson = {
          ...person,
          count: person.count + addedCount
        };

        dbUpsertPerson(updatedPerson).catch(e => console.error("Failed to update person count in DB", e));

        newFileIds.forEach(fid => {
          const file = newFiles[fid];
          if (file && file.aiData) {
            dbUpsertFileMetadata({
              fileId: fid,
              path: file.path,
              tags: file.tags,
              description: file.description,
              sourceUrl: file.sourceUrl,
              category: file.category,
              aiData: file.aiData,
              updatedAt: Date.now()
            }).catch(err => console.error('Failed to persist file aiData:', err));
          }
        });

        return { ...prev, files: newFiles, people: { ...prev.people, [personId]: updatedPerson } };
      }

      return prev;
    });
  };

  const handleDeletePerson = (personId: string | string[]) => {
    const idsToDelete = typeof personId === 'string' ? [personId] : personId;
    idsToDelete.forEach(id => {
      dbDeletePerson(id).catch(e => console.error("Failed to delete person from DB", e));
    });

    setState(prev => {
      const newPeople = { ...prev.people };

      idsToDelete.forEach(id => {
        delete newPeople[id];
      });

      return { ...prev, people: newPeople, activeModal: { type: null } };
    });
  };

  const handleManualAddPerson = (personIds: string[]) => {
    const fileIds = activeTab.selectedFileIds;
    if (fileIds.length === 0 || personIds.length === 0) {
      setState(s => ({ ...s, activeModal: { type: null } }));
      return;
    }
    setState(prev => {
      const newFiles = { ...prev.files };
      const newPeople = { ...prev.people };
      let anyUpdated = false;

      personIds.forEach(personId => {
        const person = newPeople[personId];
        if (!person) return;

        let countIncrease = 0;

        fileIds.forEach(fid => {
          const file = newFiles[fid];
          if (file && file.type === FileType.IMAGE) {
            const currentFaces = file.aiData?.faces || [];
            if (!currentFaces.some(f => f.personId === personId)) {
              const newFace: AiFace = {
                id: Math.random().toString(36).substr(2, 9),
                personId: personId,
                name: person.name,
                confidence: 1.0,
                box: { x: 0, y: 0, w: 0, h: 0 }
              };
              const newAiData = file.aiData ? { ...file.aiData, faces: [...currentFaces, newFace] } : {
                analyzed: false,
                analyzedAt: new Date().toISOString(),
                description: '',
                tags: [],
                faces: [newFace],
                sceneCategory: '',
                confidence: 1.0,
                dominantColors: [],
                objects: []
              };
              newFiles[fid] = { ...file, aiData: newAiData };
              countIncrease++;
              anyUpdated = true;
            }
          }
        });

        if (countIncrease > 0) {
          const updatedPerson = {
            ...person,
            count: person.count + countIncrease,
            coverFileId: person.coverFileId || fileIds[0]
          };
          newPeople[personId] = updatedPerson;

          dbUpsertPerson(updatedPerson).catch(e => console.error("Failed to update person count in DB", e));
        }
      });

      if (anyUpdated) {
        fileIds.forEach(fid => {
          const file = newFiles[fid];
          if (file && file.aiData) {
            dbUpsertFileMetadata({
              fileId: fid,
              path: file.path,
              tags: file.tags,
              description: file.description,
              sourceUrl: file.sourceUrl,
              category: file.category,
              aiData: file.aiData,
              updatedAt: Date.now()
            }).catch(err => console.error('Failed to persist file aiData:', err));
          }
        });

        return { ...prev, files: newFiles, people: newPeople, activeModal: { type: null } };
      }
      return { ...prev, activeModal: { type: null } };
    });
    showToast(t('context.saved'));
  };

  const handleClearPersonInfo = (fileIds: string[], personIdsToClear?: string[]) => {
    setState(prev => {
      const newFiles = { ...prev.files };
      const newPeople = { ...prev.people };
      let updated = false;

      const personIdsToUpdate = new Set<string>();

      fileIds.forEach(fid => {
        const file = newFiles[fid];
        if (file && file.type === FileType.IMAGE && file.aiData?.faces) {
          let updatedFaces: AiFace[];

          if (personIdsToClear && personIdsToClear.length > 0) {
            updatedFaces = file.aiData.faces.filter(face => !personIdsToClear.includes(face.personId));
          } else {
            updatedFaces = [];
          }

          if (updatedFaces.length !== file.aiData.faces.length) {
            file.aiData.faces.forEach(face => {
              personIdsToUpdate.add(face.personId);
            });
            updatedFaces.forEach(face => {
              personIdsToUpdate.add(face.personId);
            });

            const newAiData = { ...file.aiData, faces: updatedFaces };
            newFiles[fid] = { ...file, aiData: newAiData };
            updated = true;
          }
        }
      });

      if (updated) {
        personIdsToUpdate.forEach(personId => {
          let newCount = 0;
          Object.values(newFiles).forEach(file => {
            if (file.type === FileType.IMAGE && file.aiData?.faces) {
              if (file.aiData.faces.some(face => face.personId === personId)) {
                newCount++;
              }
            }
          });
          if (newPeople[personId]) {
            newPeople[personId] = { ...newPeople[personId], count: newCount };
          }
        });
      }

      if (updated) {
        return { ...prev, files: newFiles, people: newPeople };
      }
      return prev;
    });
  };

  const onStartRenamePerson = (personId: string) => { setState(s => ({ ...s, activeModal: { type: 'rename-person', data: { personId } } })); };

  const handleSetAvatar = (personId: string) => {
    const person = state.people[personId];
    if (person && person.coverFileId) {
      const coverFile = state.files[person.coverFileId];
      if (coverFile) {
        setState(s => ({
          ...s,
          activeModal: {
            type: 'crop-avatar',
            data: {
              personId: person.id,
              fileUrl: convertFileSrc(coverFile.path),
              initialBox: person.faceBox
            }
          }
        }));
      }
    }
  };

  const handleOpenCropAvatar = (
    fileId: string,
    personId: string,
    fileUrl: string,
    initialBox?: { x: number; y: number; w: number; h: number },
    customFileIds?: string[],
    smartCreateData?: any
  ) => {
    setState(s => ({
      ...s,
      activeModal: {
        type: 'crop-avatar',
        data: {
          personId,
          fileUrl,
          initialBox,
          customFileIds,
          smartCreateData
        }
      }
    }));
  };

  const handleSaveAvatarCrop = (personId: string, box: { x: number, y: number, w: number, h: number, imageId?: string | null }) => {
    const updates: Partial<Person> = { faceBox: box };

    if (box.imageId) {
      updates.coverFileId = box.imageId;
    }

    handleUpdatePerson(personId, updates);
    setState(s => ({ ...s, activeModal: { type: null } }));
    showToast(t('context.saved'));
  };

  const handleSaveAvatarCropForSmartCreate = (box: { x: number, y: number, w: number, h: number, imageId?: string | null }) => {
    const modalData = state.activeModal.data as any;
    if (modalData?.smartCreateData) {
      modalData.smartCreateData.faceBox = box;
      if (box.imageId) {
        modalData.smartCreateData.coverFileId = box.imageId;
      }
      setState(s => ({
        ...s,
        activeModal: {
          type: 'smart-create-person',
          data: modalData.smartCreateData
        }
      }));
      showToast(t('context.saved'));
    }
  };

  return {
    handlePersonClick,
    handleRenamePerson,
    handleUpdatePerson,
    handleCreatePerson,
    handleConfirmCreatePerson,
    handleSmartCreatePerson,
    handleSmartAddToPerson,
    handleDeletePerson,
    handleManualAddPerson,
    handleClearPersonInfo,
    onStartRenamePerson,
    handleSetAvatar,
    handleOpenCropAvatar,
    handleSaveAvatarCrop,
    handleSaveAvatarCropForSmartCreate,
  };
};
