
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Sidebar } from './components/TreeSidebar';
import { MetadataPanel } from './components/MetadataPanel';
import { ImageViewer } from './components/ImageViewer';
import { SequenceViewer } from './components/SequenceViewer';
import { TabBar } from './components/TabBar';
import { TopBar } from './components/TopBar';
import { FileGrid, InlineRenameInput } from './components/FileGrid';
import { TopicModule } from './components/TopicModule';
import { SettingsModal } from './components/SettingsModal';
import { AuroraLogo } from './components/Logo';
import { CloseConfirmationModal } from './components/CloseConfirmationModal';
import { initializeFileSystem, formatSize } from './utils/mockFileSystem';
import { translations } from './utils/translations';
import { debounce } from './utils/debounce';
import { performanceMonitor } from './utils/performanceMonitor';
import { scanDirectory, scanFile, openDirectory, saveUserData as tauriSaveUserData, loadUserData as tauriLoadUserData, getDefaultPaths as tauriGetDefaultPaths, ensureDirectory, createFolder, renameFile, deleteFile, getThumbnail, hideWindow, showWindow, exitApp, copyFile, moveFile, writeFileFromBytes, pauseColorExtraction, resumeColorExtraction, searchByColor, getAssetUrl, openPath, dbGetAllPeople, dbUpsertPerson, dbDeletePerson } from './api/tauri-bridge';
import { AppState, FileNode, FileType, SlideshowConfig, AppSettings, SearchScope, SortOption, TabState, LayoutMode, SUPPORTED_EXTENSIONS, DateFilter, SettingsCategory, AiData, TaskProgress, Person, Topic, HistoryItem, AiFace, GroupByOption, FileGroup, DeletionTask, AiSearchFilter } from './types';
import { Search, Folder, Image as ImageIcon, ArrowUp, X, FolderOpen, Tag, Folder as FolderIcon, Settings, Moon, Sun, Monitor, RotateCcw, Copy, Move, ChevronDown, FileText, Filter, Trash2, Undo2, Globe, Shield, QrCode, Smartphone, ExternalLink, Sliders, Plus, Layout, List, Grid, Maximize, AlertTriangle, Merge, FilePlus, ChevronRight, HardDrive, ChevronsDown, ChevronsUp, FolderPlus, Calendar, Server, Loader2, Database, Palette, Check, RefreshCw, Scan, Cpu, Cloud, FileCode, Edit3, Minus, User, Type, Brain, Sparkles, Crop, LogOut, XCircle, Pause } from 'lucide-react';
import { aiService } from './services/aiService';

// ... (helper components remain unchanged)
const TaskProgressModal = ({ tasks, onMinimize, onClose, t, onPauseResume }: any) => {
  const [isMinimizing, setIsMinimizing] = useState(false);
  const activeTasks = tasks.filter((task: any) => !task.minimized);
  if (activeTasks.length === 0) return null;
  const handleMinimize = () => { setIsMinimizing(true); setTimeout(() => { activeTasks.forEach((task: any) => onMinimize(task.id)); setIsMinimizing(false); }, 300); };
  
  const handlePauseResume = (taskId: string, taskType: string) => {
    if (taskType !== 'color') return;
    onPauseResume(taskId, taskType);
  };
  
  // 格式化预估时间（毫秒）为 HH:MM:SS
  const formatEstimatedTime = (ms: number | undefined): string => {
    if (!ms || ms < 0) return '';
    
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    } else {
      return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
  };
  
  return (
    <div className={`fixed bottom-6 left-1/2 transform -translate-x-1/2 z-[100] transition-all duration-300 ease-in-out origin-bottom ${isMinimizing ? 'scale-75 opacity-0 translate-y-full' : 'scale-100 opacity-100'}`}>
      <div className="w-96 bg-white dark:bg-gray-800 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden animate-slide-up">
        <div className="bg-gray-100 dark:bg-gray-900 px-4 py-2 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center"><span className="font-bold text-sm text-gray-700 dark:text-gray-200">{t('sidebar.tasks')} ({activeTasks.length})</span><div className="flex space-x-1"><button onClick={handleMinimize} className="p-1 hover:bg-gray-200 dark:hover:bg-gray-800 rounded text-gray-500"><Minus size={14}/></button></div></div>
        <div className="max-h-64 overflow-y-auto p-4 space-y-4">{activeTasks.map((task: any) => (
          <div key={task.id} className="space-y-1">
            <div className="flex justify-between items-center">
              <span className="truncate pr-2 text-xs text-gray-600 dark:text-gray-400 flex-1">{task.title}</span>
              <div className="flex items-center space-x-2">
                <span className="text-xs text-gray-600 dark:text-gray-400">{Math.round((task.current / Math.max(task.total, 1)) * 100)}%</span>
                {task.type === 'color' && (
                  <button 
                    onClick={() => handlePauseResume(task.id, task.type)}
                    className="p-1 hover:bg-gray-200 dark:hover:bg-gray-800 rounded text-gray-500"
                    title={task.status === 'paused' ? t('tasks.resume') : t('tasks.pause')}
                  >
                    {task.status === 'paused' ? <Loader2 size={12} className="animate-spin" /> : <Pause size={12} />}
                  </button>
                )}
              </div>
            </div>
            {task.currentStep && <div className="text-xs text-gray-500 dark:text-gray-500 truncate">{task.currentStep}</div>}
            {task.currentFile && <div className="text-xs text-gray-500 dark:text-gray-500 truncate">{task.currentFile}</div>}
            {task.estimatedTime && task.estimatedTime > 0 && (
              <div className="text-xs text-gray-500 dark:text-gray-500 truncate">
                剩余时间: {formatEstimatedTime(task.estimatedTime)}
              </div>
            )}
            <div className="w-full bg-gray-200 dark:bg-gray-700 h-1.5 rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all duration-300 ${task.status === 'paused' ? 'bg-yellow-500' : 'bg-blue-500'}`} 
                style={{ width: `${(task.current / Math.max(task.total, 1)) * 100}%` }}
              ></div>
            </div>
          </div>
        ))}</div>
      </div>
    </div>
  );
};

const AlertModal = ({ message, onClose, t }: any) => ( <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl max-w-sm w-full animate-zoom-in"><div className="flex items-center mb-4 text-orange-500"><AlertTriangle className="mr-2" /><h3 className="font-bold text-lg">{t('settings.title')}</h3></div><p className="mb-6 text-gray-700 dark:text-gray-300">{message}</p><div className="flex justify-end"><button onClick={onClose} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm font-medium">{t('settings.confirm')}</button></div></div> );
const ConfirmModal = ({ title, message, subMessage, confirmText, confirmIcon: Icon, onClose, onConfirm, t }: any) => ( <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl max-w-sm w-full animate-zoom-in"><h3 className="font-bold text-lg mb-2 text-gray-900 dark:text-white">{title}</h3><p className="text-gray-700 dark:text-gray-300 mb-2 text-sm">{message}</p>{subMessage && <p className="text-sm text-gray-500 mb-6 bg-gray-50 dark:bg-gray-900/50 p-2 rounded border border-gray-100 dark:border-gray-700">{subMessage}</p>}<div className="flex justify-end space-x-3"><button onClick={onClose} className="px-4 py-2 rounded text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm">{t('settings.cancel')}</button><button onClick={onConfirm} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 flex items-center text-sm font-medium">{Icon && <Icon size={16} className="mr-2"/>}{confirmText || t('settings.confirm')}</button></div></div> );
const RenameTagModal = ({ initialTag, onConfirm, onClose, t }: any) => { const [val, setVal] = useState(initialTag); return ( <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-80 animate-zoom-in"><h3 className="font-bold text-lg mb-4 text-gray-900 dark:text-white">{t('context.renameTag')}</h3><input id="rename-tag-input" name="rename-tag-input" className="w-full border dark:border-gray-600 rounded p-2 mb-4 bg-transparent text-gray-900 dark:text-white focus:outline-none focus:ring-2 ring-blue-500" value={val} onChange={e => setVal(e.target.value)} autoFocus /><div className="flex justify-end space-x-2"><button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">{t('settings.cancel')}</button><button onClick={() => onConfirm(initialTag, val)} className="bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 text-sm">{t('settings.confirm')}</button></div></div> ); };
const RenamePersonModal = ({ initialName, onConfirm, onClose, t }: any) => { const [val, setVal] = useState(initialName); return ( <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-80 animate-zoom-in"><h3 className="font-bold text-lg mb-4 text-gray-900 dark:text-white">{t('context.renamePerson')}</h3><input id="rename-person-input" name="rename-person-input" className="w-full border dark:border-gray-600 rounded p-2 mb-4 bg-transparent text-gray-900 dark:text-white focus:outline-none focus:ring-2 ring-blue-500" value={val} onChange={e => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { onConfirm(val); } }} autoFocus /><div className="flex justify-end space-x-2"><button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">{t('settings.cancel')}</button><button onClick={() => onConfirm(val)} className="bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 text-sm">{t('settings.confirm')}</button></div></div> ); };
const BatchRenameModal = ({ count, onConfirm, onClose, t }: any) => { const [pattern, setPattern] = useState('Image_###'); const [startNum, setStartNum] = useState(1); return ( <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-96 animate-zoom-in"><h3 className="font-bold text-lg mb-1 text-gray-900 dark:text-white">{t('context.batchRename')}</h3><p className="text-xs text-gray-500 mb-4">{t('meta.selected')} {count} {t('context.files')}</p><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1" htmlFor="batch-rename-pattern">{t('settings.namePattern')}</label><input id="batch-rename-pattern" name="batch-rename-pattern" className="w-full border dark:border-gray-600 rounded p-2 mb-2 bg-transparent text-gray-900 dark:text-white focus:outline-none focus:ring-2 ring-blue-500 font-mono text-sm" value={pattern} onChange={e => setPattern(e.target.value)} placeholder="Name_###" /><p className="text-xs text-gray-400 mb-4">{t('settings.patternHelp')}</p><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1" htmlFor="batch-rename-start">{t('settings.startNumber')}</label><input type="number" id="batch-rename-start" name="batch-rename-start" className="w-full border dark:border-gray-600 rounded p-2 mb-4 bg-transparent text-gray-900 dark:text-white focus:outline-none focus:ring-2 ring-blue-500" value={startNum} onChange={e => setStartNum(parseInt(e.target.value))} /><div className="flex justify-end space-x-2"><button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">{t('settings.cancel')}</button><button onClick={() => onConfirm(pattern, startNum)} className="bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 text-sm">{t('settings.confirm')}</button></div></div> ); };
const AddToPersonModal = ({ people, files, onConfirm, onClose, t }: any) => { const [search, setSearch] = useState(''); const filteredPeople = Object.values(people as Record<string, Person>).filter((p: Person) => p.name.toLowerCase().includes(search.toLowerCase())); return ( <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-80 max-h-[500px] flex flex-col animate-zoom-in"><h3 className="font-bold text-lg mb-4 text-gray-900 dark:text-white">{t('context.selectPerson')}</h3><div className="relative mb-3"><Search size={14} className="absolute left-2.5 top-2.5 text-gray-400"/><input id="add-to-person-search" name="add-to-person-search" className="w-full border dark:border-gray-600 rounded pl-8 pr-2 py-2 bg-transparent text-gray-900 dark:text-white focus:outline-none focus:ring-2 ring-blue-500 text-sm" placeholder={t('search.placeholder')} value={search} onChange={e => setSearch(e.target.value)} autoFocus /></div><div className="flex-1 overflow-y-auto min-h-[200px] space-y-1 mb-4 border border-gray-100 dark:border-gray-700 rounded p-1">{filteredPeople.map((p: Person) => { const coverFile = files[p.coverFileId]; const hasCover = !!coverFile; return ( <div key={p.id} onClick={() => onConfirm(p.id)} className="flex items-center p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded cursor-pointer group"><div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden mr-3 flex items-center justify-center">{hasCover ? (<div className="w-full h-full" style={{ backgroundImage: `url("${convertFileSrc(coverFile.path)}")`, backgroundSize: p.faceBox ? `${10000 / Math.min(p.faceBox.w, 99.9)}% ${10000 / Math.min(p.faceBox.h, 99.9)}%` : 'cover', backgroundPosition: p.faceBox ? `${p.faceBox.x / (100 - Math.min(p.faceBox.w, 99.9)) * 100}% ${p.faceBox.y / (100 - Math.min(p.faceBox.h, 99.9)) * 100}%` : 'center', backgroundRepeat: 'no-repeat' }} />) : (<User size={14} className="text-gray-400 dark:text-gray-500" />)}</div><span className="text-sm text-gray-800 dark:text-gray-200">{p.name}</span></div> ); })}</div><div className="flex justify-end"><button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">{t('settings.cancel')}</button></div></div> ); }; 

const ClearPersonModal = ({ files, fileIds, people, onConfirm, onClose, t }: any) => { 
  // Get all unique people from selected files 
  const allPeople = new Set<string>(); 
  fileIds.forEach((fileId: string) => { 
    const file = files[fileId]; 
    if (file && file.type === FileType.IMAGE && file.aiData?.faces) { 
      file.aiData.faces.forEach((face: AiFace) => allPeople.add(face.personId)); 
    } 
  }); 
  
  const peopleList = Array.from(allPeople).map(personId => people[personId]).filter(Boolean); 
  const [selectedPeople, setSelectedPeople] = useState<string[]>(peopleList.map(p => p.id)); 
  
  const handleTogglePerson = (personId: string) => { 
    setSelectedPeople(prev => 
      prev.includes(personId) 
        ? prev.filter(id => id !== personId) 
        : [...prev, personId] 
    ); 
  }; 
  
  const handleSelectAll = () => { 
    setSelectedPeople(peopleList.map(p => p.id)); 
  }; 
  
  const handleSelectNone = () => { 
    setSelectedPeople([]); 
  }; 
  
  return ( 
    <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-80 max-h-[500px] flex flex-col animate-zoom-in"> 
      <h3 className="font-bold text-lg mb-4 text-gray-900 dark:text-white">{t('context.selectPeopleToClear')}</h3> 
      <div className="flex justify-between items-center mb-3 text-sm"> 
        <span className="text-gray-600 dark:text-gray-400">{t('context.selected')} {selectedPeople.length} / {peopleList.length}</span> 
        <div className="space-x-2"> 
          <button onClick={handleSelectAll} className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200">{t('context.selectAll')}</button> 
          <button onClick={handleSelectNone} className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200">{t('context.selectNone')}</button> 
        </div> 
      </div> 
      <div className="flex-1 overflow-y-auto min-h-[200px] space-y-1 mb-4 border border-gray-100 dark:border-gray-700 rounded p-1"> 
        {peopleList.map((p: Person) => { 
          const coverFile = files[p.coverFileId]; 
          const hasCover = !!coverFile; 
          const isSelected = selectedPeople.includes(p.id); 
          return ( 
            <div key={p.id} onClick={() => handleTogglePerson(p.id)} className={`flex items-center p-2 rounded cursor-pointer group border border-transparent ${isSelected ? 'bg-blue-100 dark:bg-blue-900/50 border-l-4 border-blue-500 shadow-md font-semibold' : 'hover:bg-gray-100 dark:hover:bg-gray-700'}`}> 
              <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden mr-3 flex items-center justify-center">
                {hasCover ? (<div className="w-full h-full" style={{ backgroundImage: `url("${convertFileSrc(coverFile.path)}")`, backgroundSize: p.faceBox ? `${10000 / Math.min(p.faceBox.w, 99.9)}% ${10000 / Math.min(p.faceBox.h, 99.9)}%` : 'cover', backgroundPosition: p.faceBox ? `${p.faceBox.x / (100 - Math.min(p.faceBox.w, 99.9)) * 100}% ${p.faceBox.y / (100 - Math.min(p.faceBox.h, 99.9)) * 100}%` : 'center', backgroundRepeat: 'no-repeat' }} />) : (
                  <User size={14} className="text-gray-400 dark:text-gray-500" />
                )}
              </div> 
              <span className={`text-sm flex-1 ${isSelected ? 'text-blue-700 dark:text-blue-300' : 'text-gray-800 dark:text-gray-200'}`}>{p.name}</span> 
              <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${isSelected ? 'border-blue-600 bg-blue-600 ring-2 ring-blue-300/50 dark:ring-blue-700/50 shadow-sm' : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800'}`}> 
                {isSelected && <Check size={14} className="text-white" strokeWidth={3} />} 
              </div> 
            </div> 
          ); 
        })}
      </div> 
      <div className="flex justify-end space-x-2"> 
        <button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">{t('settings.cancel')}</button> 
        <button onClick={() => onConfirm(selectedPeople)} className="bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 text-sm">{t('settings.confirm')}</button> 
      </div> 
    </div> 
  ); 
};

const AddToTopicModal = ({ topics, onConfirm, onClose, t }: any) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const mainTopics = Object.values(topics).filter((t: any) => !t.parentId);
  const getSubTopics = (parentId: string) => Object.values(topics).filter((t: any) => t.parentId === parentId);

  const toggleExpand = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-96 max-h-[500px] flex flex-col animate-zoom-in">
      <h3 className="font-bold text-lg mb-4 text-gray-900 dark:text-white">{t('sidebar.topics')}</h3>
      <div className="flex-1 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded p-2 mb-4 max-h-[300px]">
        {mainTopics.length === 0 && <div className="text-gray-500 text-center py-4 text-sm">{t('context.noFiles')}</div>}
        {mainTopics.map((topic: any) => {
          const subTopics = getSubTopics(topic.id);
          const hasSubs = subTopics.length > 0;
          const isExpanded = expanded[topic.id];
          const isSelected = selectedId === topic.id;

          return (
            <div key={topic.id} className="mb-1">
              <div 
                className={`flex items-center p-2 rounded cursor-pointer ${isSelected ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200'}`}
                onClick={() => setSelectedId(topic.id)}
              >
                <div 
                  className={`p-1 mr-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 ${hasSubs ? 'visible' : 'invisible'}`}
                  onClick={(e) => toggleExpand(topic.id, e)}
                >
                  {isExpanded ? <ChevronsDown size={14} /> : <ChevronRight size={14} />}
                </div>
                <Layout size={16} className="mr-2" />
                <span className="truncate text-sm">{topic.name}</span>
              </div>
              
              {hasSubs && isExpanded && (
                <div className="ml-6 border-l border-gray-200 dark:border-gray-700 pl-2 mt-1 space-y-1">
                  {subTopics.map((sub: any) => (
                    <div 
                      key={sub.id} 
                      className={`flex items-center p-2 rounded cursor-pointer ${selectedId === sub.id ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200'}`}
                      onClick={() => setSelectedId(sub.id)}
                    >
                       <Layout size={14} className="mr-2 opacity-70" />
                       <span className="truncate text-sm">{sub.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-end space-x-2">
        <button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">{t('settings.cancel')}</button>
        <button 
          onClick={() => selectedId && onConfirm(selectedId)} 
          disabled={!selectedId}
          className={`px-3 py-1.5 rounded text-sm text-white transition-colors ${selectedId ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-400 cursor-not-allowed'}`}
        >
          {t('settings.confirm')}
        </button>
      </div>
    </div>
  );
};
const TagEditor = ({ file, files, onUpdate, onClose, t }: any) => { const [input, setInput] = useState(''); const allTags = new Set<string>(); Object.values(files as Record<string, FileNode>).forEach((f: any) => f.tags.forEach((t: string) => allTags.add(t))); const allTagsList = Array.from(allTags); const addTag = (tag: string) => { if (!file.tags.includes(tag)) { onUpdate(file.id, { tags: [...file.tags, tag] }); } setInput(''); }; return ( <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-96 animate-zoom-in"><h3 className="font-bold text-lg mb-4 text-gray-900 dark:text-white">{t('context.editTags')}</h3><div className="flex flex-wrap gap-2 mb-4 p-2 bg-gray-50 dark:bg-gray-900 rounded border border-gray-100 dark:border-gray-700 min-h-[40px]">{file.tags.map((tag: string) => ( <span key={tag} className="px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded text-xs flex items-center">{tag}<button onClick={() => onUpdate(file.id, { tags: file.tags.filter((t: string) => t !== tag) })} className="ml-1 hover:text-red-500"><X size={10}/></button></span> ))}</div><div className="relative mb-4"><input id="add-tag-input" name="add-tag-input" className="w-full border dark:border-gray-600 rounded p-2 bg-transparent text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 ring-blue-500" placeholder={t('meta.addTagPlaceholder')} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if(e.key === 'Enter') addTag(input); }} autoFocus />{input && ( <div className="absolute top-full left-0 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 mt-1 shadow-lg z-50 max-h-32 overflow-y-auto">{allTagsList.filter(t => t.toLowerCase().includes(input.toLowerCase())).map(t => ( <div key={t} className="px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 text-xs cursor-pointer" onClick={() => addTag(t)}>{t}</div> ))}</div> )}</div><div className="flex justify-end"><button onClick={onClose} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm">{t('viewer.done')}</button></div></div> ); };
const FolderPickerModal = ({ type, files, roots, selectedFileIds, onClose, onConfirm, t }: any) => {
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState(''); // 搜索状态
  // 初始化时将所有根目录 ID 添加到 expandedIds 中，让根目录默认展开
  const [expandedIds, setExpandedIds] = useState<string[]>(roots); // 跟踪展开的文件夹
  
  // 展开/折叠文件夹
  const handleToggle = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    setExpandedIds(prev => {
      if (prev.includes(nodeId)) {
        return prev.filter(id => id !== nodeId);
      } else {
        return [...prev, nodeId];
      }
    });
  };
  
  // 查找所有匹配的文件夹及其祖先文件夹
  const findMatchingFolders = (): Set<string> | null => {
    // 如果搜索框为空，返回 null，表示不需要过滤
    if (!searchQuery.trim()) {
      return null;
    }
    
    const matchingFolders = new Set<string>();
    const query = searchQuery.toLowerCase();
    
    // 递归遍历文件夹树，查找匹配的文件夹
    const traverse = (nodeId: string) => {
      const node = files[nodeId];
      if (!node || node.type !== FileType.FOLDER) return;
      
      // 检查当前文件夹是否匹配搜索条件
      const matches = node.name.toLowerCase().includes(query);
      
      // 获取子文件夹
      const folderChildren = node.children?.filter((childId: string) => files[childId]?.type === FileType.FOLDER) || [];
      
      // 检查是否有子文件夹匹配
      let hasMatchingChild = false;
      for (const childId of folderChildren) {
        traverse(childId);
        if (matchingFolders.has(childId)) {
          hasMatchingChild = true;
        }
      }
      
      // 如果当前文件夹匹配或有匹配的子文件夹，添加到结果中
      if (matches || hasMatchingChild) {
        matchingFolders.add(nodeId);
      }
    };
    
    // 从所有根目录开始遍历
    roots.forEach((rootId: string) => traverse(rootId));
    
    return matchingFolders;
  };
  
  // 递归渲染文件夹树，支持搜索过滤
  const renderTree = (nodeId: string, depth = 0, matchingFolders?: Set<string> | null) => {
    const node = files[nodeId];
    if (!node || node.type !== FileType.FOLDER) return null;
    if (selectedFileIds.includes(nodeId)) return null;
    
    // 如果有搜索条件，检查当前文件夹是否应该显示
    const shouldShow = !matchingFolders || matchingFolders.has(nodeId);
    if (!shouldShow) return null;
    
    const expanded = expandedIds.includes(nodeId);
    const folderChildren = node.children?.filter((childId: string) => files[childId]?.type === FileType.FOLDER) || [];
    
    return (
      <div key={nodeId}>
        <div 
          className={`flex items-center py-1 px-2 cursor-pointer text-sm border border-transparent ${currentId === nodeId ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 border-l-4 border-blue-500 shadow-md font-semibold' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => setCurrentId(nodeId)}
        >
          {/* 展开/折叠按钮 */}
          <div 
            className="p-1 mr-1 hover:bg-black/10 dark:hover:bg-white/10 rounded"
            onClick={(e) => handleToggle(e, nodeId)}
          >
            {folderChildren.length > 0 ? (
              expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
            ) : <div className="w-[14px]" />}
          </div>
          <Folder size={14} className="mr-2 text-blue-500"/>
          <span className="truncate">{node.name}</span>
        </div>
        {/* 只渲染展开的文件夹 */}
        {expanded && folderChildren.map((childId: string) => renderTree(childId, depth + 1, matchingFolders))}
      </div>
    );
  };
  
  const matchingFolders = findMatchingFolders();
  
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-96 h-[500px] flex flex-col animate-zoom-in">
      <h3 className="font-bold text-lg mb-2 text-gray-900 dark:text-white">
        {type === 'copy-to-folder' ? t('context.copyTo') : t('context.moveTo')}
      </h3>
      
      {/* 搜索框 */}
      <div className="relative mb-4">
        <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400"/>
        <input
          type="text"
          id="folder-picker-search"
          name="folder-picker-search"
          className="w-full border dark:border-gray-600 rounded pl-8 pr-2 py-2 bg-transparent text-gray-900 dark:text-white focus:outline-none focus:ring-2 ring-blue-500 text-sm"
          placeholder={t('search.placeholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoFocus
        />
        {searchQuery && (
          <button
            className="absolute right-2.5 top-2.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            onClick={() => setSearchQuery('')}
          >
            <X size={14} />
          </button>
        )}
      </div>
      
      <div className="flex-1 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded mb-4 p-2 bg-gray-50 dark:bg-gray-900/50">
        {roots.map((rootId: string) => renderTree(rootId, 0, matchingFolders))}
      </div>
      <div className="flex justify-end space-x-2">
        <button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">
          {t('settings.cancel')}
        </button>
        <button 
          onClick={() => currentId && onConfirm(currentId)} 
          disabled={!currentId}
          className="bg-blue-600 disabled:opacity-50 text-white px-3 py-1.5 rounded hover:bg-blue-700 text-sm"
        >
          {t('settings.confirm')}
        </button>
      </div>
    </div>
  );
};
const getPinyinGroup = (char: string) => { if (!char) return '#'; const c = char.charAt(0); if (/^[a-zA-Z]/.test(c)) return c.toUpperCase(); if (/^[0-9]/.test(c)) return c; if (/[\u4e00-\u9fa5]/.test(c)) { try { const collator = new Intl.Collator('zh-Hans-CN', { sensitivity: 'accent' }); const boundaries = [{ char: '阿', group: 'A' }, { char: '芭', group: 'B' }, { char: '擦', group: 'C' }, { char: '搭', group: 'D' }, { char: '蛾', group: 'E' }, { char: '发', group: 'F' }, { char: '噶', group: 'G' }, { char: '哈', group: 'H' }, { char: '击', group: 'J' }, { char: '喀', group: 'K' }, { char: '垃', group: 'L' }, { char: '妈', group: 'M' }, { char: '拿', group: 'N' }, { char: '哦', group: 'O' }, { char: '啪', group: 'P' }, { char: '期', group: 'Q' }, { char: '然', group: 'R' }, { char: '撒', group: 'S' }, { char: '塌', group: 'T' }, { char: '挖', group: 'W' }, { char: '昔', group: 'X' }, { char: '压', group: 'Y' }, { char: '匝', group: 'Z' }]; for (let i = boundaries.length - 1; i >= 0; i--) { if (collator.compare(c, boundaries[i].char) >= 0) return boundaries[i].group; } } catch (e) { console.warn('Native pinyin grouping failed', e); } } return '#'; };
const DUMMY_TAB: TabState = { id: 'dummy', folderId: '', viewingFileId: null, viewMode: 'browser' as const, layoutMode: 'grid', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null, activeTopicId: null, selectedFileIds: [], selectedTopicIds: [], lastSelectedId: null, selectedTagIds: [], selectedPersonIds: [], dateFilter: { start: null, end: null, mode: 'created' }, history: { stack: [], currentIndex: -1 }, scrollTop: 0 };

const ExitConfirmModal = ({ remember, onConfirm, onCancel, onRememberChange, t }: any) => {
    return (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl max-w-sm w-full animate-zoom-in">
            <h3 className="font-bold text-lg mb-2 text-gray-900 dark:text-white">{t('exitModal.title')}</h3>
            <p className="text-gray-700 dark:text-gray-300 mb-6 text-sm">{t('exitModal.message')}</p>
            
            <div className="flex items-center mb-6">
                <input 
                    type="checkbox" 
                    id="rememberChoice"
                    checked={remember} 
                    onChange={(e) => onRememberChange(e.target.checked)}
                    className="mr-2"
                />
                <label htmlFor="rememberChoice" className="text-sm text-gray-600 dark:text-gray-400 select-none cursor-pointer">{t('exitModal.remember')}</label>
            </div>

            <div className="flex justify-end space-x-3">
                <button onClick={() => onConfirm('minimize')} className="px-4 py-2 rounded text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm border border-gray-300 dark:border-gray-600">
                    {t('exitModal.minimize')}
                </button>
                <button onClick={() => onConfirm('exit')} className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 flex items-center text-sm font-medium">
                    <LogOut size={16} className="mr-2"/>
                    {t('exitModal.exit')}
                </button>
            </div>
        </div>
    );
};

interface ToastItemProps {
  task: DeletionTask;
  onUndo: () => void;
  onDismiss: () => void;
  t: (key: string) => string;
}

const ToastItem: React.FC<ToastItemProps> = ({ task, onUndo, onDismiss: onDismissProp, t }) => { useEffect(() => { const timer = setTimeout(() => { onDismissProp(); }, 5000); return () => clearTimeout(timer); }, []); return ( <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl animate-toast-up overflow-hidden pointer-events-auto border border-gray-200 dark:border-gray-700 flex flex-col min-w-[300px]"><div className="px-4 py-3 flex items-center gap-3 relative z-10 justify-between"><div className="flex items-center"><span className="text-sm text-gray-700 dark:text-gray-200 whitespace-nowrap">{t('context.deletedItems').replace('{count}', task.files.length.toString())}</span><button onClick={onUndo} className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 font-bold text-sm flex items-center whitespace-nowrap ml-2"><Undo2 size={16} className="mr-1"/> {t('context.undo')}</button></div><button onClick={onDismissProp} className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"><X size={16}/></button></div><div className="h-1 bg-gray-100 dark:bg-gray-700 w-full"><div className="h-full bg-blue-500 animate-countdown origin-left"></div></div></div> ); };
const WelcomeModal = ({ show, onFinish, onSelectFolder, currentPath, settings, onUpdateSettings, t }: any) => { const [step, setStep] = useState(1); if (!show) return null; return ( <div className="fixed inset-0 z-[200] bg-white dark:bg-gray-950 flex flex-col items-center justify-center p-8 animate-fade-in"><div className="max-w-2xl w-full bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden flex flex-col md:flex-row h-[500px]"><div className="w-full md:w-1/2 bg-blue-600 p-8 flex flex-col justify-between text-white relative overflow-hidden"><div className="z-10"><div className="flex items-center space-x-2 mb-4"><AuroraLogo size={40} className="shadow-lg" /><span className="font-bold text-xl tracking-wider">AURORA</span></div><h1 className="text-3xl font-bold leading-tight mb-4">{step === 1 ? t('welcome.step1Title') : t('welcome.step2Title')}</h1><p className="text-blue-100 opacity-90">{step === 1 ? t('welcome.step1Desc') : t('welcome.step2Desc')}</p></div><div className="absolute -bottom-20 -right-20 w-64 h-64 bg-blue-500 rounded-full opacity-50 blur-3xl"></div><div className="absolute top-20 -left-20 w-48 h-48 bg-purple-500 rounded-full opacity-30 blur-3xl"></div><div className="flex space-x-2 z-10"><div className={`h-1.5 w-8 rounded-full transition-colors ${step === 1 ? 'bg-white' : 'bg-white/30'}`}></div><div className={`h-1.5 w-8 rounded-full transition-colors ${step === 2 ? 'bg-white' : 'bg-white/30'}`}></div></div></div><div className="w-full md:w-1/2 p-8 flex flex-col relative bg-gray-50 dark:bg-gray-900">{step === 1 && (<div className="flex-1 flex flex-col justify-center space-y-6"><div className="text-center"><div className="w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center mx-auto mb-4 text-blue-600 dark:text-blue-400"><HardDrive size={32} /></div><button onClick={onSelectFolder} className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-blue-500/30 transition-all active:scale-95 flex items-center justify-center w-full">{t('welcome.selectFolder')}</button></div>{currentPath && (<div className="bg-gray-100 dark:bg-gray-800 p-3 rounded-lg border border-gray-200 dark:border-gray-700 text-center"><div className="text-xs text-gray-500 uppercase font-bold mb-1">{t('welcome.currentPath')}</div><div className="text-sm font-mono truncate px-2">{currentPath}</div></div>)}</div>)}{step === 2 && (<div className="flex-1 space-y-6 flex flex-col justify-center"><div><label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{t('settings.language')}</label><div className="grid grid-cols-2 gap-3">{['zh', 'en'].map(lang => (<button key={lang} onClick={() => onUpdateSettings({ language: lang })} className={`px-3 py-2 rounded-lg border text-sm font-medium transition-all ${settings.language === lang ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800'}`}>{lang === 'zh' ? '中文' : 'English'}</button>))}</div></div><div><label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{t('settings.theme')}</label><div className="grid grid-cols-3 gap-2">{['light', 'dark', 'system'].map(theme => (<button key={theme} onClick={() => onUpdateSettings({ theme })} className={`px-2 py-2 rounded-lg border text-xs font-medium transition-all flex flex-col items-center justify-center ${settings.theme === theme ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800'}`}>{theme === 'light' && <Sun size={16} className="mb-1"/>}{theme === 'dark' && <Moon size={16} className="mb-1"/>}{theme === 'system' && <Monitor size={16} className="mb-1"/>}{t(`settings.theme${theme.charAt(0).toUpperCase() + theme.slice(1)}`)}</button>))}</div></div></div>)}<div className="mt-6 flex justify-between items-center pt-6 border-t border-gray-100 dark:border-gray-800">{step === 2 ? (<button onClick={onFinish} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm font-medium px-4">{t('welcome.skip')}</button>) : (<div></div>)}<button onClick={() => { if (step === 1) { if (currentPath) setStep(2); } else { onFinish(); } }} disabled={step === 1 && !currentPath} className={`px-6 py-2 rounded-full font-bold text-sm transition-all flex items-center ${step === 1 && !currentPath ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 shadow-lg'}`}>{step === 1 ? t('welcome.next') : t('welcome.finish')}<ChevronRight size={16} className="ml-2" /></button></div></div></div></div> ); };

// ... (CropAvatarModal and other helpers remain unchanged)
const CropAvatarModal = ({ fileUrl, initialBox, personId, allFiles, people, onConfirm, onClose, t }: any) => {
  // 基础状态
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // 文件列表状态
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [currentImageId, setCurrentImageId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  
  // 初始化时设置当前图片ID
  useEffect(() => {
    // 找到与fileUrl对应的文件
    const initialFile: any = Object.values(allFiles).find((file: any) => {
      return file.url === fileUrl || convertFileSrc(file.path) === fileUrl;
    });
    
    if (initialFile) {
      setSelectedFile(initialFile.id);
      setCurrentImageId(initialFile.id);
    }
  }, [fileUrl, allFiles]);
  
  // 获取该人物下的所有图片
  const getPersonImages = () => {
    const images: any[] = [];
    
    Object.values(allFiles).forEach((file: any) => {
      if (file.type === 'image' && file.aiData?.faces) {
        const hasPerson = file.aiData.faces.some((face: any) => face.personId === personId);
        if (hasPerson) {
          images.push(file);
        }
      }
    });
    
    return images;
  };
  
  const personImages = getPersonImages();
  
  // 过滤图片
  const filteredImages = personImages.filter(img => 
    img.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  
  // 处理图片选择
  const handleImageSelect = (file: any) => {
    setSelectedFile(file.id);
    setCurrentImageId(file.id);
    // 重置缩放和位置
    setScale(1);
    setPosition({ x: 0, y: 0 });
    // 更新当前显示的图片URL
    const newFileUrl = convertFileSrc(file.path);
    // 触发重新渲染
    if (imgRef.current) {
      imgRef.current.src = newFileUrl;
    }
  };
  
  const VIEWPORT_SIZE = 400;
  const CROP_SIZE = 250;
  const OFFSET = (VIEWPORT_SIZE - CROP_SIZE) / 2;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  };
  
  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && imgRef.current) {
      let newX = e.clientX - dragStart.x;
      let newY = e.clientY - dragStart.y;
      
      const w = imgRef.current.naturalWidth * scale;
      const h = imgRef.current.naturalHeight * scale;
      
      const minX = OFFSET + CROP_SIZE - w;
      const maxX = OFFSET;
      const minY = OFFSET + CROP_SIZE - h;
      const maxY = OFFSET;
      
      if (newX > maxX) newX = maxX;
      if (newX < minX) newX = minX;
      if (newY > maxY) newY = maxY;
      if (newY < minY) newY = minY;
      
      setPosition({ x: newX, y: newY });
    }
  };
  
  const handleMouseUp = () => setIsDragging(false);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      let initialScale;
      let initialPosition = { x: 0, y: 0 };
      
      if (initialBox) {
          // 如果有初始人脸框，根据人脸框计算缩放和位置
          const boxWidth = img.naturalWidth * (initialBox.w / 100);
          const boxHeight = img.naturalHeight * (initialBox.h / 100);
          const boxAspect = boxWidth / boxHeight;
          
          // 计算适合裁剪区域的缩放比例
          const scaleX = CROP_SIZE * 1.5 / boxWidth;
          const scaleY = CROP_SIZE * 1.5 / boxHeight;
          initialScale = Math.max(scaleX, scaleY);
          
          // 计算位置，使人脸框中心对准裁剪区域中心
          const boxCenterX = img.naturalWidth * (initialBox.x / 100) + boxWidth / 2;
          const boxCenterY = img.naturalHeight * (initialBox.y / 100) + boxHeight / 2;
          
          initialPosition = {
              x: VIEWPORT_SIZE / 2 - boxCenterX * initialScale,
              y: VIEWPORT_SIZE / 2 - boxCenterY * initialScale
          };
      } else {
          // 默认行为：居中显示
          const minScale = CROP_SIZE / Math.min(img.naturalWidth, img.naturalHeight);
          initialScale = Math.max(minScale, 0.5);
          
          initialPosition = {
              x: (VIEWPORT_SIZE - img.naturalWidth * initialScale) / 2,
              y: (VIEWPORT_SIZE - img.naturalHeight * initialScale) / 2
          };
      }
      
      setScale(initialScale);
      setPosition(initialPosition);
  };
  
  const handleWheel = (e: React.WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!imgRef.current) return;
      
      const ZOOM_SPEED = 0.1;
      const direction = Math.sign(e.deltaY);
      let newScale = scale;
      
      if (direction < 0) {
          newScale = scale * (1 + ZOOM_SPEED);
      } else {
          newScale = scale / (1 + ZOOM_SPEED);
      }
      
      const minScale = CROP_SIZE / Math.min(imgRef.current.naturalWidth, imgRef.current.naturalHeight);
      newScale = Math.max(minScale, Math.min(newScale, 5)); 
      
      const w = imgRef.current.naturalWidth * newScale;
      const h = imgRef.current.naturalHeight * newScale;
      
      let newX = position.x;
      let newY = position.y;
      
      const cx = (OFFSET + CROP_SIZE/2 - position.x) / scale;
      const cy = (OFFSET + CROP_SIZE/2 - position.y) / scale;
      
      newX = OFFSET + CROP_SIZE/2 - cx * newScale;
      newY = OFFSET + CROP_SIZE/2 - cy * newScale;
      
      const minX = OFFSET + CROP_SIZE - w;
      const maxX = OFFSET;
      const minY = OFFSET + CROP_SIZE - h;
      const maxY = OFFSET;
      
      if (newX > maxX) newX = maxX;
      if (newX < minX) newX = minX;
      if (newY > maxY) newY = maxY;
      if (newY < minY) newY = minY;
      
      setScale(newScale);
      setPosition({ x: newX, y: newY });
  };

  const handleSave = () => {
      if (!imgRef.current) return;
      const natW = imgRef.current.naturalWidth;
      const natH = imgRef.current.naturalHeight;
      
      const x = (OFFSET - position.x) / scale;
      const y = (OFFSET - position.y) / scale;
      const w = CROP_SIZE / scale;
      const h = CROP_SIZE / scale;
      
      onConfirm({
          x: (x / natW) * 100,
          y: (y / natH) * 100,
          w: (w / natW) * 100,
          h: (h / natH) * 100,
          imageId: currentImageId
      });
  };
  
  useEffect(() => {
      const el = containerRef.current;
      if (el) {
          const wheelListener = (e: WheelEvent) => handleWheel(e as any);
          el.addEventListener('wheel', wheelListener, { passive: false });
          return () => el.removeEventListener('wheel', wheelListener);
      }
  }, [scale, position]);

  return (
    <div className="fixed inset-0 z-[150] bg-black/70 flex items-center justify-center p-4 animate-fade-in" onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl overflow-hidden flex flex-col md:flex-row w-full max-w-4xl max-h-[90vh]">
            {/* 左侧：裁剪区域 */}
            <div className="flex flex-col w-full md:w-1/2 p-6">
                <div className="font-bold text-gray-800 dark:text-white mb-4">
                    <span>{t('context.cropAvatar')}</span>
                </div>
                <div 
                    ref={containerRef}
                    className="relative bg-gray-100 dark:bg-black overflow-hidden cursor-move select-none flex-shrink-0"
                    style={{ width: VIEWPORT_SIZE, height: VIEWPORT_SIZE, margin: '0 auto' }}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                >
                    <img 
                       ref={imgRef}
                       src={fileUrl}
                       draggable={false}
                       onLoad={handleImageLoad}
                       className="max-w-none absolute origin-top-left pointer-events-none"
                       style={{ 
                           transform: `translate(${position.x}px, ${position.y}px) scale(${scale})` 
                       }}
                    />
                    <div className="absolute inset-0 pointer-events-none">
                        <svg width="100%" height="100%">
                            <defs>
                                <mask id="cropMask">
                                    <rect x="0" y="0" width="100%" height="100%" fill="white" />
                                    <circle cx={VIEWPORT_SIZE/2} cy={VIEWPORT_SIZE/2} r={CROP_SIZE/2} fill="black" />
                                </mask>
                            </defs>
                            <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.6)" mask="url(#cropMask)" />
                            
                            <circle 
                                cx={VIEWPORT_SIZE/2} 
                                cy={VIEWPORT_SIZE/2} 
                                r={CROP_SIZE/2} 
                                fill="none" 
                                stroke="white" 
                                strokeWidth="2" 
                                style={{ filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.5))' }}
                            />
                        </svg>
                    </div>
                </div>
                <div className="mt-6 space-y-4">
                    <div className="flex items-center space-x-3">
                        <Minus size={16} className="text-gray-500"/>
                        <input 
                        type="range" 
                        id="crop-zoom-slider"
                        name="crop-zoom-slider"
                        min="0.1" 
                        max="5" 
                        step="0.01" 
                        value={scale}
                        onChange={(e) => {
                            const newScale = parseFloat(e.target.value);
                            if (imgRef.current) {
                                const minScale = CROP_SIZE / Math.min(imgRef.current.naturalWidth, imgRef.current.naturalHeight);
                                if (newScale >= minScale) setScale(newScale);
                            } else {
                                setScale(newScale);
                            }
                        }}
                        className="flex-1 h-1.5 bg-gray-300 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer"
                    />
                        <Plus size={16} className="text-gray-500"/>
                    </div>
                    <div className="flex justify-end space-x-3">
                        <button onClick={onClose} className="px-4 py-2 rounded text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">{t('settings.cancel')}</button>
                        <button onClick={handleSave} className="px-6 py-2 rounded text-sm bg-blue-600 text-white hover:bg-blue-700 font-bold shadow-lg">{t('settings.confirm')}</button>
                    </div>
                </div>
            </div>
            
            {/* 右侧：文件列表 */}
            <div className="w-full md:w-1/2 border-l border-gray-200 dark:border-gray-800 overflow-hidden flex flex-col">
                <div className="p-4 border-b border-gray-200 dark:border-gray-800">
                    <div className="relative">
                        <input
                            type="text"
                            placeholder={t('search.placeholder')}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-10 pr-4 py-2 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                        />
                        <Search size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
                    </div>
                </div>
                
                <div className="flex-1 overflow-y-auto p-4">
                    {filteredImages.length === 0 ? (
                        <div className="text-center text-gray-500 dark:text-gray-400 py-8">
                            <p>{t('context.noImagesFound')}</p>
                            {searchQuery && <p className="text-sm mt-2">{t('context.noImagesMatchingQuery')}</p>}
                        </div>
                    ) : (
                        <div className="grid grid-cols-3 gap-3">
                            {filteredImages.map((file) => {
                                const isSelected = selectedFile === file.id;
                                return (
                                    <div
                                        key={file.id}
                                        onClick={() => handleImageSelect(file)}
                                        className={`cursor-pointer rounded-lg overflow-hidden border-2 transition-all duration-200 hover:shadow-md ${
                                            isSelected ? 'border-blue-500 shadow-lg' : 'border-transparent hover:border-blue-300 dark:hover:border-blue-700'
                                        }`}
                                    >
                                        <div className="relative">
                                            <img
                                                src={convertFileSrc(file.path)}
                                                className="w-full h-24 object-cover"
                                                alt={file.name}
                                            />
                                            {isSelected && (
                                                <div className="absolute inset-0 bg-blue-500/30 flex items-center justify-center">
                                                    <Check size={24} className="text-white" />
                                                </div>
                                            )}
                                        </div>
                                        <div className="p-2 bg-white dark:bg-gray-800">
                                            <p className="text-xs text-gray-600 dark:text-gray-300 truncate">
                                                {file.name}
                                            </p>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    </div>
  );
};

import SplashScreen from './components/SplashScreen';
import { DragDropOverlay, DropAction } from './components/DragDropOverlay';

// 导入统一的环境检测工具
import { isTauriEnvironment, detectTauriEnvironmentAsync } from './utils/environment';

// 扩展 Window 接口以包含我们的全局函数
declare global {
  interface Window {
    __UPDATE_FILE_COLORS__?: (filePath: string, colors: string[]) => void;
  }
}

export const App: React.FC = () => {
  const [state, setState] = useState<AppState>({
    roots: [], files: {}, people: {}, topics: {}, expandedFolderIds: [], tabs: [], activeTabId: '', sortBy: 'name', sortDirection: 'asc', thumbnailSize: 180, renamingId: null, clipboard: { action: null, items: { type: 'file', ids: [] } }, customTags: [], folderSettings: {}, layout: { isSidebarVisible: true, isMetadataVisible: true },
    slideshowConfig: { interval: 3000, transition: 'fade', isRandom: false, enableZoom: true },
    settings: {
        theme: 'system',
        language: 'zh',
        autoStart: false,
        exitAction: 'ask',
        animateOnHover: true,
        paths: { resourceRoot: 'C:\\Users\\User\\Pictures\\AuroraGallery', cacheRoot: 'C:\\AppData\\Local\\Aurora\\Cache' },
        search: { isAISearchEnabled: false },
        performance: {
            refreshInterval: 5000 // 默认5秒刷新一次
        },
        ai: {
            provider: 'ollama',
            openai: { apiKey: '', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o' },
            ollama: { endpoint: 'http://localhost:11434', model: 'llava' },
            lmstudio: { endpoint: 'http://localhost:1234/v1', model: 'local-model' },
            autoTag: false,
            autoDescription: false,
            enhancePersonDescription: false,
            enableFaceRecognition: false,
            autoAddPeople: false,
            enableOCR: false,
            enableTranslation: false,
            targetLanguage: 'zh',
            confidenceThreshold: 0.6
        }
    },
    isSettingsOpen: false, settingsCategory: 'general', activeModal: { type: null }, tasks: [],
    aiConnectionStatus: 'checking',
    // 拖拽状态
    dragState: {
      isDragging: false,
      draggedFileIds: [],
      sourceFolderId: null,
      dragOverFolderId: null,
      dragOverPosition: null
    }
  });


  // ... (keep all state variables and hooks identical)
  const [isLoading, setIsLoading] = useState(true);
  const [showSplash, setShowSplash] = useState(true);
  const [hasShownWelcome, setHasShownWelcome] = useState(false);
  const [loadingInfo, setLoadingInfo] = useState<string[]>([]);
  // Selection box state
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  
  // 组件卸载时清理逻辑
  useEffect(() => {
    return () => {
      // 清理所有定时器
      timerRefs.current.forEach((timer) => {
        clearInterval(timer);
      });
      timerRefs.current.clear();
      
      // 取消防抖任务更新
      debouncedTaskUpdate.cancel();
      
      // 应用所有暂存的任务更新，确保最终一致性
      if (taskUpdatesRef.current.size > 0) {
        setState(prev => {
          const updatedTasks = prev.tasks.map(t => {
            const updates = taskUpdatesRef.current.get(t.id);
            if (updates) {
              return { ...t, ...updates };
            }
            return t;
          });
          
          taskUpdatesRef.current.clear();
          
          return { ...prev, tasks: updatedTasks };
        });
      }
    };
  }, []);

  const [hoverPlayingId, setHoverPlayingId] = useState<string | null>(null);
  const [isCreatingTag, setIsCreatingTag] = useState(false);
  const [tagSearchQuery, setTagSearchQuery] = useState(''); 
  const lastSelectedTagRef = useRef<string | null>(null);
  const [deletionTasks, setDeletionTasks] = useState<DeletionTask[]>([]);
  const [contextMenu, setContextMenu] = useState<{ visible: boolean; x: number; y: number; type: 'file-single' | 'file-multi' | 'folder-single' | 'folder-multi' | 'tag-single' | 'tag-multi' | 'tag-background' | 'root-folder' | 'background' | 'tab' | 'person' | null; targetId?: string; }>({ visible: false, x: 0, y: 0, type: null });
  const [toast, setToast] = useState<{msg: string, visible: boolean}>({ msg: '', visible: false });
  const [toolbarQuery, setToolbarQuery] = useState('');
  const [groupBy, setGroupBy] = useState<GroupByOption>('none');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [rememberExitChoice, setRememberExitChoice] = useState(false);
  // Ref to store the latest exit action preference (to avoid closure issues)
  const exitActionRef = useRef<'ask' | 'minimize' | 'exit'>('ask');
  // State for close confirmation modal
  const [showCloseConfirmation, setShowCloseConfirmation] = useState(false);
  
  // External drag and drop state
  const [isExternalDragging, setIsExternalDragging] = useState(false);
  const [externalDragItems, setExternalDragItems] = useState<string[]>([]);
  const [externalDragPosition, setExternalDragPosition] = useState<{ x: number; y: number } | null>(null);
  const [hoveredDropAction, setHoveredDropAction] = useState<DropAction>(null);
  
  // Internal drag state for tracking external drag operations
  const [isDraggingInternal, setIsDraggingInternal] = useState(false);
  const [draggedFilePaths, setDraggedFilePaths] = useState<string[]>([]);
  
  // 自定义事件监听器，用于更新文件颜色
  useEffect(() => {
    // 定义事件处理函数
    const handleColorUpdate = (event: CustomEvent) => {
      const { filePath, colors } = event.detail;
      if (!filePath || !colors) return;
      
      // 找到对应的文件ID
      const fileEntry = Object.entries(state.files).find(([id, file]) => file.path === filePath);
      if (fileEntry) {
        const [fileId, file] = fileEntry;
        // 更新文件的 meta.palette，保持其他 meta 字段不变
        const currentMeta = file.meta;
        if (currentMeta) {
          handleUpdateFile(fileId, {
            meta: {
              ...currentMeta,
              palette: colors
            }
          });
        } else {
          // 如果没有 meta，创建一个基本的 meta 对象
          handleUpdateFile(fileId, {
            meta: {
              width: 0,
              height: 0,
              sizeKb: 0,
              created: new Date().toISOString(),
              modified: new Date().toISOString(),
              format: '',
              palette: colors
            }
          });
        }
      }
    };
    
    // 添加事件监听器
    window.addEventListener('color-update', handleColorUpdate as EventListener);
    
    // 清理函数
    return () => {
      window.removeEventListener('color-update', handleColorUpdate as EventListener);
    };
  }, [state.files]); // 依赖 files，确保能正确找到文件

  // 监听主色调提取进度事件
  const colorTaskIdRef = useRef<string | null>(null);
  const colorBatchIdRef = useRef<number>(-1); // 初始化为 -1，以免与批次ID 0 冲突
  useEffect(() => {
    let isMounted = true;
    
    const listenProgress = async () => {
      try {
        const unlisten = await listen('color-extraction-progress', (event: any) => {
          if (!isMounted) return;
          
          const progress = event.payload as { 
            batchId: number; 
            current: number; 
            total: number; 
            pending: number; 
            currentFile: string;
            batchCompleted: boolean;
          };
          
          // 忽略 total 为 0 的无效进度
          if (progress.total === 0) {
            return;
          }
          
          // 检查是否是新批次
          const isNewBatch = progress.batchId !== colorBatchIdRef.current;
          
          if (isNewBatch) {
            // 防止旧批次干扰：如果收到的批次ID比当前的小且不为-1，忽略
            if (colorBatchIdRef.current !== -1 && progress.batchId < colorBatchIdRef.current) {
              return;
            }

            // 新批次：关闭旧任务，创建新任务
            const oldTaskId = colorTaskIdRef.current;
            if (oldTaskId) {
              setState(prev => ({ 
                ...prev, 
                tasks: prev.tasks.filter(t => t.id !== oldTaskId) 
              }));
            }
            
            // 创建新任务
            const taskId = startTask('color', [], t('tasks.processingColors'), false);
            colorTaskIdRef.current = taskId;
            colorBatchIdRef.current = progress.batchId;
            
            eprintln(`=== New color extraction batch ${progress.batchId} started, total: ${progress.total} ===`);
          }
          
          // 更新任务进度
          if (colorTaskIdRef.current) {
            const now = Date.now();
            
            // 获取当前任务状态
            let lastProgress = 0;
            let lastProgressUpdate = now;
            let taskStatus = 'running';
            let totalProcessedTime = 0;
            let existingEstimatedTime: number | undefined = undefined;
            let lastEstimatedTimeUpdate = now;
            
            setState(prev => {
              const task = prev.tasks.find(t => t.id === colorTaskIdRef.current);
              if (task) {
                lastProgress = task.lastProgress || 0;
                lastProgressUpdate = task.lastProgressUpdate || now;
                existingEstimatedTime = task.estimatedTime;
                lastEstimatedTimeUpdate = task.lastEstimatedTimeUpdate || now;
                taskStatus = task.status;
                totalProcessedTime = task.totalProcessedTime || 0;
              }
              return prev;
            });
            
            // 计算预估时间
            let calculatedEstimatedTime: number | undefined = existingEstimatedTime;
            let shouldUpdateEstimatedTime = false;
            
            if (taskStatus === 'running' && progress.current > lastProgress && now > lastProgressUpdate) {
              const elapsedTime = now - lastProgressUpdate;
              const currentSpeed = (totalProcessedTime + elapsedTime) > 0 
                ? progress.current / (totalProcessedTime + elapsedTime) 
                : 0;
              
              const remainingTasks = Math.max(0, progress.total - progress.current);
              
              if (currentSpeed > 0 && remainingTasks > 0) {
                const newEstimatedTime = remainingTasks / currentSpeed;
                const timeSinceLastEstimatedUpdate = now - lastEstimatedTimeUpdate;
                
                if (timeSinceLastEstimatedUpdate >= 3000 || !existingEstimatedTime) {
                  calculatedEstimatedTime = newEstimatedTime;
                  lastEstimatedTimeUpdate = now;
                  shouldUpdateEstimatedTime = true;
                }
              } else if (remainingTasks <= 0) {
                calculatedEstimatedTime = 0;
                shouldUpdateEstimatedTime = true;
              }
            }
            
            // 只有处理了至少10个文件后才显示预估时间
            let estimatedTime = progress.current >= 10 ? calculatedEstimatedTime : undefined;
            if (taskStatus === 'paused') {
              estimatedTime = undefined;
            }
            
            // 计算新的处理时间
            let newTotalProcessedTime = totalProcessedTime;
            if (taskStatus === 'running' && progress.current > lastProgress && now > lastProgressUpdate) {
              newTotalProcessedTime += now - lastProgressUpdate;
            }
            
            const taskUpdates: any = { 
              current: progress.current, 
              total: progress.total,
              currentFile: progress.currentFile,
              currentStep: `${progress.current} / ${progress.total}`,
              estimatedTime,
              lastProgressUpdate: now,
              lastProgress: progress.current,
              totalProcessedTime: newTotalProcessedTime
            };
            
            if (shouldUpdateEstimatedTime) {
              taskUpdates.lastEstimatedTimeUpdate = lastEstimatedTimeUpdate;
            }
            
            updateTask(colorTaskIdRef.current, taskUpdates);
            
            // 检测批次完成
            if (progress.batchCompleted) {
              updateTask(colorTaskIdRef.current, { status: 'completed' });
              
              // 延迟1秒后关闭任务窗口
              const currentTaskId = colorTaskIdRef.current;
              setTimeout(() => {
                if (isMounted && currentTaskId) {
                  setState(prev => ({ 
                    ...prev, 
                    tasks: prev.tasks.filter(t => t.id !== currentTaskId) 
                  }));
                  // 只有当当前任务ID未变化时才清除引用
                  if (colorTaskIdRef.current === currentTaskId) {
                    colorTaskIdRef.current = null;
                  }
                }
              }, 1000);
            }
          }
        });
        
        return unlisten;
      } catch (error) {
        console.error('Failed to listen for color extraction progress:', error);
        return () => {};
      }
    };
    
    // Helper function for logging
    const eprintln = (msg: string) => {
      console.log(`[ColorExtraction] ${msg}`);
    };
    
    const unlistenPromise = listenProgress();
    
    return () => {
      isMounted = false;
      unlistenPromise.then(unlistenFn => unlistenFn()).catch(console.error);
    };
  }, []);

  
  // Throttle function to limit how often a function can be called
  const throttle = useCallback((func: Function, limit: number) => {
    let inThrottle: boolean;
    return function(this: any, ...args: any[]) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  }, []);
  
  // Selection box ref for direct DOM manipulation
  const selectionBoxRef = useRef<HTMLDivElement | null>(null);
  
  // Memoized selection box bounds for efficiency
  const selectionBoundsRef = useRef({ left: 0, top: 0, right: 0, bottom: 0 });
  
  const [showWelcome, setShowWelcome] = useState(false);

  // ... (keep persistence logic, init effect, exit logic, etc.)
  const saveUserData = async (data: any) => {
      // 优先检测 Tauri 环境（异步检测，通过实际调用 API）
      const isTauriEnv = await detectTauriEnvironmentAsync();

      if (isTauriEnv) {
          // Tauri 环境 - 使用 Tauri API
          try {
              return await tauriSaveUserData(data);
          } catch (error) {
              console.error('Failed to save user data in Tauri:', error);
              return false;
          }
      } else {
          return false;
      }
  };

  useEffect(() => {
      // 只在 Tauri 环境下保存数据
      // 注意：这里使用同步检测，因为 useEffect 不能是 async
      // 但 saveUserData 内部会进行异步检测
      const isTauriEnv = isTauriEnvironment();
      
      if (!isTauriEnv) {
          return;
      }
      
      const rootPaths = state.roots.map(id => state.files[id]?.path).filter(Boolean);
      
      const fileMetadata: Record<string, any> = {};
      Object.values(state.files).forEach((file) => {
          const hasUserTags = file.tags && file.tags.length > 0;
          const hasDesc = !!file.description;
          const hasSource = !!file.sourceUrl;
          const hasAiData = !!file.aiData;
          const hasCategory = file.category && file.category !== 'general';
          const hasHeavyMeta = file.meta && (file.meta.width > 0 || file.meta.palette);

          if (hasUserTags || hasDesc || hasSource || hasAiData || hasCategory || hasHeavyMeta) {
              fileMetadata[file.path] = {
                  tags: file.tags,
                  description: file.description,
                  sourceUrl: file.sourceUrl,
                  aiData: file.aiData,
                  category: file.category,
                  meta: file.meta ? {
                      width: file.meta.width,
                      height: file.meta.height,
                      palette: file.meta.palette,
                      format: file.meta.format,
                  } : undefined
              };
          }
      });

      const dataToSave = {
          rootPaths,
          customTags: state.customTags,
          people: state.people,
          topics: state.topics,
          folderSettings: state.folderSettings,
          settings: state.settings,
          fileMetadata
      };
      
      const timer = setTimeout(async () => {
          try {
              await saveUserData(dataToSave);
          } catch (err) {
              console.error('Auto save failed:', err);
          }
      }, 1000);
      return () => clearTimeout(timer);
  }, [state.roots, state.files, state.customTags, state.people, state.topics, state.settings, state.folderSettings]);

  useEffect(() => {
    const init = async () => {
        // 优先检测 Tauri 环境（异步检测，通过实际调用 API）
        const isTauriEnv = await detectTauriEnvironmentAsync();
        if (isTauriEnv) {
            // Tauri 环境或浏览器环境
            const isTauriSyncEnv = isTauriEnvironment();
            let isSavedDataLoaded = false;
            
            if (isTauriSyncEnv) {
                // Tauri 环境：尝试加载保存的数据
                try {
                    // 先获取默认路径
                    const defaults = await tauriGetDefaultPaths();
                    // 然后获取保存的数据
                    const savedData = await tauriLoadUserData();
                    
                    // 合并设置：保存的数据优先于默认数据
                    let finalSettings = {
                        ...state.settings,
                        paths: {
                            ...state.settings.paths,
                            ...defaults,
                        }
                    };
                    
                    if (savedData) {
                        isSavedDataLoaded = true;
                        
                        // 如果有保存的数据，合并保存的数据，保存的数据优先
                        finalSettings = {
                            ...finalSettings,
                            ...savedData.settings,
                            paths: {
                                ...finalSettings.paths,
                                ...(savedData.settings?.paths || {})
                            },
                            ai: {
                                ...finalSettings.ai,
                                ...(savedData.settings?.ai || {})
                            }
                        };
                        
                        // 如果没有做过迁移，尝试将 user_data.json 中的 people 迁移到数据库（仅在 DB 为空时执行）
                        if (!savedData._migratedToDb) {
                            try {
                                const existing = await dbGetAllPeople();
                                if ((!existing || existing.length === 0) && savedData.people && Object.keys(savedData.people).length > 0) {
                                    // 逐条写入数据库
                                    for (const id of Object.keys(savedData.people)) {
                                        const p: any = savedData.people[id];
                                        const toUpsert = {
                                            id: p.id || id,
                                            name: p.name || '',
                                            coverFileId: p.coverFileId || '',
                                            count: p.count || 0,
                                            description: p.description || null,
                                            faceBox: p.faceBox || null,
                                            updatedAt: Date.now()
                                        };
                                        await dbUpsertPerson(toUpsert);
                                    }
                                    // 标记已迁移，避免重复迁移
                                    await tauriSaveUserData({ ...savedData, _migratedToDb: true });
                                    showToast('People migrated to database');
                                }
                            } catch (err) {
                                console.error('People migration failed:', err);
                            }
                        }

                        // 更新 state 中的 customTags 和 people
                        setState(prev => ({
                            ...prev,
                            customTags: savedData.customTags || [],
                            people: savedData.people || {},
                            topics: savedData.topics || {},
                            folderSettings: savedData.folderSettings || {},
                            settings: finalSettings
                        }));
                        // 立即更新 ref 以确保事件监听器使用正确的值
                        exitActionRef.current = finalSettings.exitAction || 'ask';
                    } else {
                        // 只有默认路径，更新 state
                        setState(prev => ({
                            ...prev,
                            settings: finalSettings
                        }));
                        // 立即更新 ref
                        exitActionRef.current = finalSettings.exitAction || 'ask';
                    }
                    
                    // 确定要扫描的路径列表
                    let pathsToScan: string[] = [];
                    let validRootPaths: string[] = [];
                    
                    if (savedData?.rootPaths && Array.isArray(savedData.rootPaths) && savedData.rootPaths.length > 0) {
                        // 先过滤掉明显的非目录路径（如包含文件扩展名的路径）
                        validRootPaths = savedData.rootPaths.filter((path: string) => {
                            // 检查路径是否包含文件扩展名
                            const lastDotIndex = path.lastIndexOf('.');
                            const lastSlashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
                            // 如果没有点，或者点在最后一个斜杠之前，那么它是一个目录
                            return lastDotIndex === -1 || lastDotIndex < lastSlashIndex;
                        });
                    }
                    
                    // 如果经过筛选后没有有效路径，或者没有保存的路径，使用默认资源根目录
                    if (validRootPaths.length === 0) {
                        if (finalSettings.paths.resourceRoot) {
                            pathsToScan = [finalSettings.paths.resourceRoot];
                        }
                    } else {
                        pathsToScan = validRootPaths;
                    }
                    
                    if (pathsToScan.length > 0) {
                        let allFiles: Record<string, FileNode> = {};
                        let allRoots: string[] = [];
                        const savedMetadata = savedData?.fileMetadata || {};
                        for (const p of pathsToScan) {
                            try {
                                // 开始记录文件扫描性能，绕过采样率
                                const scanTimer = performanceMonitor.start('scanDirectory', undefined, true);
                                
                                const result = await scanDirectory(p);
                                
                                // 结束计时并记录性能指标
                                performanceMonitor.end(scanTimer, 'scanDirectory', {
                                    path: p,
                                    fileCount: Object.keys(result.files).length,
                                    rootCount: result.roots.length
                                });
                                
                                // 记录扫描文件数量
                                performanceMonitor.increment('filesScanned', Object.keys(result.files).length);
                                
                                Object.values(result.files).forEach((f: any) => {
                                    const saved = savedMetadata[f.path];
                                    if (saved) {
                                        if (saved.tags) f.tags = saved.tags;
                                        if (saved.description) f.description = saved.description;
                                        if (saved.sourceUrl) f.sourceUrl = saved.sourceUrl;
                                        if (saved.aiData) f.aiData = saved.aiData;
                                        if (saved.category) f.category = saved.category;
                                        if (saved.meta && f.meta) {
                                            if (saved.meta.width) f.meta.width = saved.meta.width;
                                            if (saved.meta.height) f.meta.height = saved.meta.height;
                                            if (saved.meta.palette) f.meta.palette = saved.meta.palette;
                                        }
                                    }
                                });

                                Object.assign(allFiles, result.files);
                                allRoots.push(...result.roots);
                            } catch (err) {
                                console.error(`Failed to reload root: ${p}`, err);
                            }
                        }
                        if (allRoots.length > 0) {
                            setState(prev => {
                                 const initialFolder = allRoots[0];
                                 const defaultTab: TabState = { ...DUMMY_TAB, id: 'tab-default', folderId: initialFolder };
                                 defaultTab.history = { stack: [{ folderId: initialFolder, viewingId: null, viewMode: 'browser', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 };
                                 
                                 return {
                                    ...prev,
                                    roots: allRoots,
                                    files: allFiles,
                                    expandedFolderIds: allRoots,
                                    tabs: [defaultTab],
                                    activeTabId: defaultTab.id
                                 };
                            });
                            setIsLoading(false);
                            // 根目录加载完毕，隐藏启动界面
                            setTimeout(() => {
                                setShowSplash(false);
                            }, 500);
                            return; 
                        } else {
                            // 虽然有保存的数据，但是没有有效的根目录，需要使用默认初始化
                            isSavedDataLoaded = false;
                        }
                    }
                } catch (e) {
                    console.error("Tauri initialization failed", e);
                    // 初始化失败，使用默认初始化
                    isSavedDataLoaded = false;
                }
            }
            
            if (!isSavedDataLoaded) {
                // 如果没有加载到保存的数据，使用默认初始化
                const { roots, files } = initializeFileSystem(); 
                const initialFolder = roots[0];
                const defaultTab: TabState = { ...DUMMY_TAB, id: 'tab-default', folderId: initialFolder, history: { stack: [{ folderId: initialFolder, viewingId: null, viewMode: 'browser', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 } };
                setState(prev => ({ ...prev, roots, files, people: {}, expandedFolderIds: roots, tabs: [defaultTab], activeTabId: defaultTab.id }));
            }
            
            setIsLoading(false);
            // 初始化完成，隐藏启动界面
            setTimeout(() => {
                setShowSplash(false);
            }, 500);
        }
    };
    init();
  }, []);

  // ... (keep exit handler)
  const handleExitConfirm = async (action: 'minimize' | 'exit') => {
      if (rememberExitChoice) {
          const newSettings = { 
              ...state.settings, 
              exitAction: action 
          };
          setState(prev => ({ ...prev, settings: newSettings, activeModal: { type: null } }));
          await saveUserData({
              rootPaths: state.roots.map(id => state.files[id]?.path).filter(Boolean),
              customTags: state.customTags,
              people: state.people,
              settings: newSettings,
              fileMetadata: {}
          });
      } else {
          setState(s => ({ ...s, activeModal: { type: null } }));
      }
      // Tauri环境下的窗口关闭逻辑由Tauri框架处理
  };

  const activeTab = useMemo(() => {
     return state.tabs.find(t => t.id === state.activeTabId) || DUMMY_TAB;
  }, [state.tabs, state.activeTabId]);


  // Update exitActionRef when state changes
  useEffect(() => {
    exitActionRef.current = state.settings.exitAction;
  }, [state.settings.exitAction]);

  // Listen for window close requests (Tauri only)
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupCloseListener = async () => {
      try {
        // Only set up listener in Tauri environment
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();

        unlisten = await currentWindow.onCloseRequested(async (event) => {
          // Prevent default close behavior
          event.preventDefault();

          // Check user's exit action preference from ref (always latest value)
          const exitAction = exitActionRef.current;

          if (exitAction === 'minimize') {
            // Minimize to tray
            await hideWindow();
          } else if (exitAction === 'exit') {
            // Exit immediately
            currentWindow.destroy();
          } else {
            // Ask user (default behavior)
            setShowCloseConfirmation(true);
          }
        });
      } catch (error) {
        // Not in Tauri environment or error occurred, ignore
        console.log('Window close listener not available:', error);
      }
    };

    setupCloseListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []); // Empty dependency array - ref is always current


  // ... (keep welcome modal logic)
  useEffect(() => {
      if (!isLoading) {
          // 无论什么情况，初始化完成后都要隐藏启动界面
          setTimeout(() => {
              setShowSplash(false);
          }, 500);
          
          if (state.roots.length === 0) {
              const hasOnboarded = localStorage.getItem('aurora_onboarded');
              if (!hasOnboarded) {
                  // 显示欢迎界面
                  setShowWelcome(true);
              }
          }
      }
  }, [isLoading, state.roots.length]);

  const handleWelcomeFinish = () => {
      localStorage.setItem('aurora_onboarded', 'true');
      setShowWelcome(false);
  };

  // 更新CSS变量以控制字母索引栏位置
  useEffect(() => {
    // 设置CSS变量，根据详情面板的可见性调整索引栏位置
    document.documentElement.style.setProperty(
      '--metadata-panel-width', 
      state.layout.isMetadataVisible ? '20rem' : '0rem'
    );
  }, [state.layout.isMetadataVisible]);

  // ... (keep dimension loading, folder expanding, theme, sort, etc.)

  
  // Lazy load dimensions when file is selected
  useEffect(() => {
      // 目前仅在Tauri环境下支持延迟加载图片尺寸
  }, [activeTab.selectedFileIds, activeTab.viewingFileId]);

  useEffect(() => {
    const currentFolderId = activeTab.folderId;
    if (!currentFolderId) return;
    setState(prev => {
        const files = prev.files;
        if (!files[currentFolderId]) return prev;
        const ancestorsToExpand = new Set<string>();
        let curr = files[currentFolderId];
        while (curr && curr.parentId) { ancestorsToExpand.add(curr.parentId); curr = files[curr.parentId]; }
        if (ancestorsToExpand.size === 0) return prev;
        const existingExpanded = new Set(prev.expandedFolderIds);
        let changed = false;
        ancestorsToExpand.forEach(id => { if (!existingExpanded.has(id)) { existingExpanded.add(id); changed = true; } });
        if (!changed) return prev;
        return { ...prev, expandedFolderIds: Array.from(existingExpanded) };
    });
  }, [activeTab.folderId]);

  useEffect(() => {
    const root = window.document.documentElement;
    const applyTheme = () => {
      const theme = state.settings.theme;
      let isDark = false;
      if (theme === 'dark') isDark = true;
      else if (theme === 'light') isDark = false;
      else { 
          if (window.matchMedia('(prefers-color-scheme: dark)').matches) isDark = true; 
          else isDark = false; 
      }
      if (isDark) root.classList.add('dark');
      else root.classList.remove('dark');
    };
    applyTheme();
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => { if (state.settings.theme === 'system') applyTheme(); };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [state.settings.theme]);

  useEffect(() => { setToolbarQuery(activeTab.searchQuery); }, [activeTab.id, activeTab.searchQuery]);

  const t = (key: string): string => { const keys = key.split('.'); let val: any = translations[state.settings.language]; for (const k of keys) { val = val?.[k]; } return typeof val === 'string' ? val : key; };
  const showToast = (msg: string) => { setToast({ msg, visible: true }); setTimeout(() => setToast({ msg: '', visible: false }), 2000); };
  
  // 监听多文件选择，显示持久拖拽提示
  const selectedCount = activeTab.selectedFileIds.length;
  const showDragHint = selectedCount > 1;
  
  // ... (keep startTask and updateTask)
  // 存储所有定时器引用，用于组件卸载时清理
  const timerRefs = useRef<Map<string, number>>(new Map());
  
  const startTask = (type: 'copy' | 'move' | 'ai' | 'thumbnail' | 'color', fileIds: string[] | FileNode[], title: string, autoProgress: boolean = true) => {
    const id = Math.random().toString(36).substr(2, 9);
    const now = Date.now();
    const newTask: TaskProgress = { 
      id, 
      type: type as any, 
      title, 
      total: fileIds.length, 
      current: 0, 
      startTime: now, 
      status: 'running', 
      minimized: false,
      lastProgressUpdate: now,
      lastProgress: 0,
      estimatedTime: undefined,
      lastEstimatedTimeUpdate: now
    };
    
    // 立即添加任务，不使用防抖，确保用户立即看到任务开始
    setState(prev => ({ ...prev, tasks: [...prev.tasks, newTask] }));
    
    if (autoProgress) {
        let current = 0;
        // 降低定时器频率，从 500ms 改为 1000ms
        const interval = setInterval(() => {
            current += 1;
            // 使用优化后的 updateTask 函数，利用防抖机制
            updateTask(id, { current });
            if (current >= newTask.total) {
                clearInterval(interval);
                // 移除定时器引用
                timerRefs.current.delete(id);
                // 使用 setTimeout 延迟移除任务，让用户看到完成状态
                setTimeout(() => {
                    setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== id) }));
                }, 1000);
            }
        }, 1000);
        
        // 存储定时器引用，便于后续清理
        timerRefs.current.set(id, interval);
    }
    return id;
  };

  // 使用 ref 暂存任务更新，确保防抖时的最终一致性
  const taskUpdatesRef = useRef<Map<string, Partial<TaskProgress>>>(new Map());
  
  // 创建防抖的状态更新函数
  const debouncedTaskUpdate = useRef(
    debounce(() => {
      setState(prev => {
        // 如果没有更新，直接返回
        if (taskUpdatesRef.current.size === 0) {
          return prev;
        }
        
        // 应用所有暂存的任务更新
        const updatedTasks = prev.tasks.map(t => {
          const updates = taskUpdatesRef.current.get(t.id);
          if (updates) {
            return { ...t, ...updates };
          }
          return t;
        });
        
        // 清空暂存的更新
        taskUpdatesRef.current.clear();
        
        return { ...prev, tasks: updatedTasks };
      });
    }, 100) // 100ms 防抖延迟
  ).current;
  
  // 优化的 updateTask 函数，使用防抖处理
  const updateTask = (id: string, updates: Partial<TaskProgress>) => {
    // 将更新暂存到 ref 中
    const existingUpdates = taskUpdatesRef.current.get(id) || {};
    taskUpdatesRef.current.set(id, { ...existingUpdates, ...updates });
    
    // 调用防抖函数
    debouncedTaskUpdate();
  };

  // ... (keep navigation/file handling functions: updateActiveTab, sortFiles, getFilteredChildren, displayFileIds)
  const updateActiveTab = (updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => {
     setState(prev => { const current = prev.tabs.find(t => t.id === prev.activeTabId); if (!current) return prev; const newValues = typeof updates === 'function' ? updates(current) : updates; const newTab = { ...current, ...newValues }; return { ...prev, tabs: prev.tabs.map(t => t.id === prev.activeTabId ? newTab : t) }; });
  };

  // Cache all files array to avoid repeated Object.values() calls
  const allFiles = useMemo(() => Object.values(state.files) as FileNode[], [state.files]);

  // Memoized sort function with stable dependencies
  const sortFiles = useMemo(() => {
    return (files: FileNode[]) => {
      return files.sort((a, b) => {
        if (a.type !== b.type) return a.type === FileType.FOLDER ? -1 : 1;
        let res: number = 0;
        if (state.sortBy === 'date') { const valA = a.createdAt || ''; const valB = b.createdAt || ''; res = valA.localeCompare(valB); } 
        else if (state.sortBy === 'size') { const sizeA: number = a.meta?.sizeKb || 0; const sizeB: number = b.meta?.sizeKb || 0; res = sizeA - sizeB; } 
        else { const valA = (a.name || '').toLowerCase(); const valB = (b.name || '').toLowerCase(); res = valA.localeCompare(valB); }
        if (res === 0) return 0; const modifier = state.sortDirection === 'asc' ? 1 : -1; return res * modifier;
      });
    };
  }, [state.sortBy, state.sortDirection]);

  // Optimized filtered children calculation
  const displayFileIds = useMemo(() => {
    let candidates: FileNode[] = [];
    
    // AI Search Filter Logic - Optimized with early exits and Set lookups
    if (activeTab.aiFilter && (state.settings.search.isAISearchEnabled || activeTab.aiFilter.filePaths)) {
        const { keywords, colors, people, description, filePaths } = activeTab.aiFilter;
        
        candidates = allFiles.filter(f => {
            if (f.type !== FileType.IMAGE) return false;
            
            // Exact file path match (e.g. from color search)
            if (filePaths && filePaths.length > 0) {
                return filePaths.includes(f.path);
            }

            // Early return if no criteria match
            if (!keywords.length && !colors.length && !people.length && !description) {
                return false;
            }
            
            // Check Keywords (Tags, Objects, Description) - Optimized with early exits
            if (keywords.length > 0) {
                const lowerKeywords = keywords.map(k => k.toLowerCase());
                const hasKeywordMatch = lowerKeywords.some(lowerK => {
                    if (f.tags?.some(t => t.toLowerCase().includes(lowerK))) return true;
                    if (f.aiData?.objects?.some(o => o.toLowerCase().includes(lowerK))) return true;
                    if (f.aiData?.tags?.some(t => t.toLowerCase().includes(lowerK))) return true;
                    if (f.description?.toLowerCase().includes(lowerK)) return true;
                    if (f.aiData?.description?.toLowerCase().includes(lowerK)) return true;
                    return false;
                });
                if (!hasKeywordMatch) return false;
            }

            // Check Colors - Optimized with Set for O(1) lookups
            if (colors.length > 0) {
                const colorSet = new Set(colors.map(c => c.toLowerCase()));
                const hasColorMatch = 
                    (f.meta?.palette?.some(p => colorSet.has(p.toLowerCase()))) ||
                    (f.aiData?.dominantColors?.some(p => colorSet.has(p.toLowerCase())));
                if (!hasColorMatch) return false;
            }

            // Check People - Optimized with Set for O(1) lookups
            if (people.length > 0) {
                const peopleSet = new Set(people.map(p => p.toLowerCase()));
                const hasPeopleMatch = f.aiData?.faces?.some(face => 
                    face.name && peopleSet.has(face.name.toLowerCase())
                );
                if (!hasPeopleMatch) return false;
            }

            // Check specific description intent - Early exit if no match
            if (description) {
                const lowerDesc = description.toLowerCase();
                const descMatch = 
                    (f.description?.toLowerCase().includes(lowerDesc)) ||
                    (f.aiData?.description?.toLowerCase().includes(lowerDesc));
                if (!descMatch) return false;
            }

            return true;
        });

    } else if (activeTab.activePersonId) { 
        // Optimized active person filter - use direct lookup
        const personId = activeTab.activePersonId;
        candidates = allFiles.filter(f => 
            f.type === FileType.IMAGE && 
            f.aiData?.faces && 
            f.aiData.faces.some(face => face.personId === personId)
        );
    }
    else if (activeTab.activeTags.length > 0) { 
        // Optimized tag filter - use Set for faster lookups
        const activeTagsSet = new Set(activeTab.activeTags);
        candidates = allFiles.filter(f => 
            f.type !== FileType.FOLDER && 
            f.tags?.some(tag => activeTagsSet.has(tag))
        );
    } 
    else if (activeTab.searchScope === 'tag' && activeTab.searchQuery.startsWith('tag:')) { 
        const tagName = activeTab.searchQuery.replace('tag:', '');
        candidates = allFiles.filter((f) => f.tags?.includes(tagName)); 
    } 
    else { 
        if (!state.files[activeTab.folderId]) { 
            if (activeTab.searchQuery && activeTab.searchScope !== 'all') { /* continue */ } else { return []; } 
        } 
        
        if (activeTab.searchQuery) { 
            candidates = allFiles; 
        } else { 
            const folder = state.files[activeTab.folderId];
            candidates = folder?.children?.map(id => state.files[id]).filter(Boolean) as FileNode[] || [];
        } 
    }
    
    // Standard Search Logic (if AI Search is NOT active or falls back) - Optimized with early exits
    if (activeTab.searchQuery && !activeTab.searchQuery.startsWith('tag:') && !activeTab.aiFilter) {
      const query = activeTab.searchQuery.toLowerCase();
      const queryParts = query.split(' or ').map(p => p.trim()).filter(p => p);
      
      // Optimized search with early exits
      candidates = candidates.filter(f => {
          // Check if file matches any search part
          return queryParts.some(part => {
                // Early exit for exact matches
                const lowerPart = part.toLowerCase();
                
                // Check name first (most common case)
                if (f.name.toLowerCase().includes(lowerPart)) {
                    return true;
                }
                
                // Check tags
                if (f.tags?.some(t => t.toLowerCase().includes(lowerPart))) {
                    return true;
                }
                
                // Check description if available
                if (f.description?.toLowerCase().includes(lowerPart)) {
                    return true;
                }
                
                // Check source URL if available
                if (f.sourceUrl?.toLowerCase().includes(lowerPart)) {
                    return true;
                }
                
                // Check AI data if available
                if (f.aiData) {
                    if (f.aiData.sceneCategory?.toLowerCase().includes(lowerPart)) {
                        return true;
                    }
                    if (f.aiData.objects?.some(obj => obj.toLowerCase().includes(lowerPart))) {
                        return true;
                    }
                    if (f.aiData.extractedText?.toLowerCase().includes(lowerPart)) {
                        return true;
                    }
                    if (f.aiData.translatedText?.toLowerCase().includes(lowerPart)) {
                        return true;
                    }
                }
                
                // Check search scope
                if (activeTab.searchScope === 'file') {
                    return f.type !== FileType.FOLDER;
                }
                if (activeTab.searchScope === 'folder') {
                    return f.type === FileType.FOLDER;
                }
                
                return false;
            });
        }); 
    }
    
    // Date filter optimization
    if (activeTab.dateFilter.start && activeTab.dateFilter.end) { 
        const start = new Date(activeTab.dateFilter.start).getTime(); 
        const end = new Date(activeTab.dateFilter.end).getTime(); 
        const minTime = Math.min(start, end); 
        const maxTime = Math.max(start, end) + 86400000; 
        const mode = activeTab.dateFilter.mode;
        
        candidates = candidates.filter(f => {
            const dateStr = mode === 'created' ? f.createdAt : f.updatedAt;
            if (!dateStr) return false;
            const time = new Date(dateStr).getTime();
            return time >= minTime && time < maxTime;
        }); 
    }
    
    // Sort and return IDs
    return sortFiles(candidates).map(f => f.id);
  }, [allFiles, activeTab, state.sortBy, state.sortDirection, state.settings.search.isAISearchEnabled]);

  // ... (keep grouping logic)
  const toggleGroup = (groupId: string) => { setCollapsedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] })); };
  const groupedFiles = useMemo<FileGroup[]>(() => {
    if (groupBy === 'none') return [];
    const groups: Record<string, string[]> = {};
    displayFileIds.forEach(id => {
      const file = state.files[id]; if (!file) return; let key = 'Other';
      if (groupBy === 'type') {
        key = file.type === FileType.FOLDER ? t('groupBy.folder') : (file.meta?.format?.toUpperCase() || 'Unknown');
      } 
      else if (groupBy === 'date') {
        if (file.createdAt) { 
          const date = new Date(file.createdAt); 
          key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; 
        } else { 
          key = 'Unknown'; 
        } 
      } 
      else if (groupBy === 'size') {
        const sizeKb = file.meta?.sizeKb || 0;
        if (sizeKb < 1024) key = t('groupBy.small');
        else if (sizeKb < 10240) key = t('groupBy.medium');
        else key = t('groupBy.large');
      }
      if (!groups[key]) groups[key] = []; groups[key].push(id);
    });
    return Object.entries(groups).map(([title, ids]) => ({ id: title, title, fileIds: ids })).sort((a, b) => a.title.localeCompare(b.title));
  }, [displayFileIds, groupBy, state.files, t]);

  // ... (keep handleOpenFolder and handleRefresh)
  const handleOpenFolder = async () => { 
      try { 
          const path = await openDirectory(); 
          if (path) { 
                  // 确保缓存目录存在（在资源根目录下创建 .Aurora_Cache 文件夹）
                  if (isTauriEnvironment()) {
                      const cachePath = `${path}${path.includes('\\') ? '\\' : '/'}.Aurora_Cache`;
                      await ensureDirectory(cachePath);
                  }
                  
                  // 开始记录文件扫描性能，绕过采样率
                  const scanTimer = performanceMonitor.start('scanDirectory', undefined, true);
                  
                  const result = await scanDirectory(path, true); 
                  
                  // 结束计时并记录性能指标
                  performanceMonitor.end(scanTimer, 'scanDirectory', {
                      path,
                      fileCount: Object.keys(result.files).length,
                      rootCount: result.roots.length
                  });
                  
                  // 记录扫描文件数量
                  performanceMonitor.increment('filesScanned', Object.keys(result.files).length); 
                  setState(prev => { 
                      const newRoots = Array.from(new Set([...prev.roots, ...result.roots])); 
                      const newFiles = { ...prev.files, ...result.files }; 
                      const updatedTabs = prev.tabs.map(t => t.id === prev.activeTabId ? { ...t, folderId: result.roots[0], history: { stack: [{ folderId: result.roots[0], viewingId: null, viewMode: 'browser' as const, searchQuery: '', searchScope: 'all' as SearchScope, activeTags: [], activePersonId: null }], currentIndex: 0 } } : t); 
                      
                      return { 
                          ...prev, 
                          roots: newRoots, 
                          files: newFiles, 
                          expandedFolderIds: [...prev.expandedFolderIds, ...result.roots], 
                          tabs: updatedTabs,
                          settings: {
                              ...prev.settings,
                              paths: {
                                  ...prev.settings.paths,
                                  resourceRoot: path
                              }
                          }
                      }; 
                  }); 
              } 
          } catch (e) { console.error("Failed to open directory", e); } 
  };
  
  const handleRefresh = async (folderId?: string) => {
      const targetFolderId = folderId || activeTab.folderId;
      const folder = state.files[targetFolderId];
      
      // Handle both Electron and Tauri environments
      if (folder?.path) {
          const path = folder.path;
          try {
              const result = await scanDirectory(path, true);
              setState(prev => {
                  // Create a copy of all files
                  const mergedFiles = { ...prev.files };
                  
                  // 1. Remove all files in the refreshed folder's subtree
                  // First, identify all files in the subtree
                  const filesToRemove = new Set<string>();
                  const traverseAndMark = (fileId: string) => {
                      filesToRemove.add(fileId);
                      const file = prev.files[fileId];
                      if (file && file.children) {
                          file.children.forEach(childId => traverseAndMark(childId));
                      }
                  };
                  traverseAndMark(targetFolderId);
                  
                  // Then remove them from mergedFiles
                  filesToRemove.forEach(fileId => {
                      delete mergedFiles[fileId];
                  });
                  
                  // 2. Merge new files with existing ones, preserving user data
                  Object.entries(result.files).forEach(([fileId, newFile]) => {
                      const existingFile = prev.files[fileId];
                      if (existingFile) {
                          // Merge files, preserving user-customized data
                          mergedFiles[fileId] = {
                              ...newFile,
                              // Preserve user-added information
                              tags: existingFile.tags,
                              description: existingFile.description,
                              url: existingFile.url,
                              aiData: existingFile.aiData,
                              sourceUrl: existingFile.sourceUrl,
                              author: existingFile.author,
                              category: existingFile.category,
                              // Use new children from scan to reflect file system changes (add/remove)
                              children: newFile.children || existingFile.children,
                              // IMPORTANT: Preserve parentId for the scanned root to maintain tree structure
                              parentId: (fileId === targetFolderId) ? existingFile.parentId : newFile.parentId
                          };
                      } else {
                          // New file, add as-is
                          mergedFiles[fileId] = newFile;
                      }
                  });
                  
                  return { ...prev, files: mergedFiles };
              });
          } catch (e) {
              console.error("Failed to refresh directory", e);
          }
      } else if (folder) {
          // Handle virtual folders with no actual path
          setState(prev => {
              // Force a complete re-render by updating the folder's lastRefresh timestamp
              const files = { ...prev.files };
              files[targetFolderId] = {
                  ...folder,
                  // Add a lastRefresh timestamp to force a re-render
                  lastRefresh: Date.now()
              };
              
              return { ...prev, files };
          });
      }
  };

  
  const handleFileClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    
    // 关闭右键菜单
    closeContextMenu();
    
    // If we just finished a selection box operation, don't process the click
    if (isSelecting) return;
    
    const isCtrl = e.ctrlKey || e.metaKey; // Ctrl for Windows/Linux, Command for macOS
    const isShift = e.shiftKey;
    
    let newSelectedFileIds: string[];
    let newLastSelectedId: string = id;
    
    if (isCtrl) {
      // Ctrl+Click: Toggle selection of this file
      if (activeTab.selectedFileIds.includes(id)) {
        // Remove from selection
        newSelectedFileIds = activeTab.selectedFileIds.filter(fileId => fileId !== id);
      } else {
        // Add to selection
        newSelectedFileIds = [...activeTab.selectedFileIds, id];
      }
    } else if (isShift && activeTab.lastSelectedId && activeTab.selectedFileIds.length > 0) {
      // Shift+Click: Select range from last selected to current
      const currentFolderId = activeTab.folderId;
      let allFiles: string[] = [];
      
      if (activeTab.searchQuery) {
        // Search results view
        allFiles = displayFileIds;
      } else {
        // Folder view - use displayFileIds which already contains the sorted and filtered list of files to display
        allFiles = displayFileIds;
      }
      
      const lastIndex = allFiles.indexOf(activeTab.lastSelectedId);
      const currentIndex = allFiles.indexOf(id);
      
      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        newSelectedFileIds = allFiles.slice(start, end + 1);
      } else {
        newSelectedFileIds = [id];
      }
    } else {
      // Normal click: Select only this file
      newSelectedFileIds = [id];
    }
    
    updateActiveTab({ 
        selectedFileIds: newSelectedFileIds, 
        lastSelectedId: newLastSelectedId 
    });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    // 关闭右键菜单
    closeContextMenu();
    
    if ((e.target as HTMLElement).closest('.file-item') || (e.target as HTMLElement).closest('.tag-item') || (e.target as HTMLElement).closest('[style*="left:"]')) {
        return;
    }
    
    // Start selection box
    if (e.button === 0) { // Left mouse button
        const container = selectionRef.current;
        if (container) {
            const rect = container.getBoundingClientRect();
            const startX = e.clientX - rect.left + container.scrollLeft;
            const startY = e.clientY - rect.top + container.scrollTop;
            setIsSelecting(true);
            setSelectionBox({
                startX: startX,
                startY: startY,
                currentX: startX,
                currentY: startY
            });
            
            // Clear selection on background click
            if (activeTab.viewMode === 'browser') {
                updateActiveTab({ selectedFileIds: [] });
            } else if (activeTab.viewMode === 'tags-overview') {
                updateActiveTab({ selectedTagIds: [] });
            } else if (activeTab.viewMode === 'people-overview') {
                updateActiveTab({ selectedPersonIds: [] });
            }
        }
    }
  };
  
  // Optimized mouse move handler with throttling and direct DOM manipulation
  const handleMouseMove = useCallback(throttle((e: React.MouseEvent) => {
    if (!isSelecting || !selectionBox) return;
    
    const container = selectionRef.current;
    if (container) {
        const rect = container.getBoundingClientRect();
        const currentX = e.clientX - rect.left + container.scrollLeft;
        const currentY = e.clientY - rect.top + container.scrollTop;
        
        // Update selection box coordinates
        setSelectionBox(prev => prev ? {
            ...prev,
            currentX,
            currentY
        } : null);
        
        // Calculate bounds for selection checking
        const left = Math.min(selectionBox.startX, currentX);
        const top = Math.min(selectionBox.startY, currentY);
        const right = Math.max(selectionBox.startX, currentX);
        const bottom = Math.max(selectionBox.startY, currentY);
        
        selectionBoundsRef.current = { left, top, right, bottom };
    }
  }, 16), [isSelecting, selectionBox, throttle]);
  
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!isSelecting || !selectionBox) return;
    
    // Get the container element to calculate item positions
    const container = selectionRef.current;
    if (!container) {
      setIsSelecting(false);
      setSelectionBox(null);
      return;
    }
    
    // Calculate selection box boundaries in viewport coordinates
    const containerRect = container.getBoundingClientRect();
    const selectionLeft = containerRect.left + (Math.min(selectionBox.startX, selectionBox.currentX) - container.scrollLeft);
    const selectionTop = containerRect.top + (Math.min(selectionBox.startY, selectionBox.currentY) - container.scrollTop);
    const selectionRight = containerRect.left + (Math.max(selectionBox.startX, selectionBox.currentX) - container.scrollLeft);
    const selectionBottom = containerRect.top + (Math.max(selectionBox.startY, selectionBox.currentY) - container.scrollTop);
    
    // Check if selection box is too small to select anything
    if (selectionRight - selectionLeft < 5 && selectionBottom - selectionTop < 5) {
      setIsSelecting(false);
      setSelectionBox(null);
      return;
    }
    
    // Update selection based on view mode
    if (activeTab.viewMode === 'browser') {
      // File selection - simple and reliable approach using viewport coordinates directly
      const selectedIds: string[] = [];
      
      // Get all file elements in the current FileGrid container
      const allFileElements = container.querySelectorAll('.file-item');
      
      // Loop through all file elements and check if they are in the selection box
      allFileElements.forEach(element => {
        const id = element.getAttribute('data-id');
        if (id) {
          // Get the element's bounding rect in viewport coordinates
          const rect = element.getBoundingClientRect();
          
          // Check if element overlaps with selection box in viewport coordinates
          if (rect.left < selectionRight && 
              rect.right > selectionLeft && 
              rect.top < selectionBottom && 
              rect.bottom > selectionTop) {
            selectedIds.push(id);
          }
        }
      });
      
      // Always update selection, regardless of whether any files were selected
      updateActiveTab({
        selectedFileIds: selectedIds,
        lastSelectedId: selectedIds[selectedIds.length - 1] || null
      });
    } else if (activeTab.viewMode === 'tags-overview') {
      // Tag selection - optimized with efficient checking
      const selectedTagIds: string[] = [];
      const tagElements = document.querySelectorAll('.tag-item');
      
      // Loop through all tag elements and check if they are in the selection box
      tagElements.forEach(element => {
        const tag = element.getAttribute('data-tag');
        if (tag) {
          // Get the element's bounding rect in viewport coordinates
          const rect = element.getBoundingClientRect();
          
          // Check if element overlaps with selection box in viewport coordinates
          if (rect.left < selectionRight && 
              rect.right > selectionLeft && 
              rect.top < selectionBottom && 
              rect.bottom > selectionTop) {
            selectedTagIds.push(tag);
          }
        }
      });
      
      if (selectedTagIds.length > 0) {
        updateActiveTab({ selectedTagIds });
      }
    } else if (activeTab.viewMode === 'people-overview') {
      // Person selection - use the same logic as FileGrid for consistent positioning
      const selectedPersonIds: string[] = [];
      
      // Get all people and filter by search query (same as FileGrid)
      let itemsList = Object.values(state.people);
      if (activeTab.searchQuery && activeTab.searchQuery.trim()) {
        const query = activeTab.searchQuery.toLowerCase().trim();
        itemsList = itemsList.filter(person => 
            person.name.toLowerCase().includes(query)
        );
      }
      
      // Sort people alphabetically by name, same as in handlePersonClick and useLayout
      itemsList.sort((a, b) => a.name.localeCompare(b.name));
      
      // Calculate layout parameters (same as FileGrid)
      const containerWidth = container.clientWidth;
      const thumbnailSize = state.thumbnailSize;
      const GAP = 16;
      const PADDING = 16;
      const availableWidth = Math.max(100, containerWidth - (PADDING * 2));
      const minColWidth = thumbnailSize;
      const cols = Math.max(1, Math.floor((availableWidth + GAP) / (minColWidth + GAP)));
      const itemWidth = (availableWidth - (cols - 1) * GAP) / cols;
      const itemHeight = itemWidth + 60;
      
      // Check each person's position against selection box
      itemsList.forEach((person, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        
        // Calculate person position in container coordinates (not viewport)
        // This accounts for scrolling correctly
        const personContainerLeft = PADDING + col * (itemWidth + GAP);
        const personContainerTop = PADDING + row * (itemHeight + GAP);
        const personContainerRight = personContainerLeft + itemWidth;
        const personContainerBottom = personContainerTop + itemHeight;
        
        // Calculate selection box in container coordinates (not viewport)
        const selContainerLeft = Math.min(selectionBox.startX, selectionBox.currentX);
        const selContainerTop = Math.min(selectionBox.startY, selectionBox.currentY);
        const selContainerRight = Math.max(selectionBox.startX, selectionBox.currentX);
        const selContainerBottom = Math.max(selectionBox.startY, selectionBox.currentY);
        
        // Check if person overlaps with selection box in container coordinates
        // This works correctly regardless of scrolling
        if (personContainerLeft < selContainerRight && 
            personContainerRight > selContainerLeft && 
            personContainerTop < selContainerBottom && 
            personContainerBottom > selContainerTop) {
          selectedPersonIds.push(person.id);
        }
      });
      
      // Always update selection, even if no people were selected (consistent with file selection)
      updateActiveTab({ selectedPersonIds });
    }
    
    // End selection box
    setIsSelecting(false);
    setSelectionBox(null);
  }, [isSelecting, selectionBox, activeTab.viewMode, state.people, state.thumbnailSize, updateActiveTab]);

  
  const groupedTags: Record<string, string[]> = useMemo(() => { const allTags = new Set<string>(state.customTags); (Object.values(state.files) as FileNode[]).forEach(f => f.tags.forEach(t => allTags.add(t))); const filteredTags = Array.from(allTags).filter(t => !tagSearchQuery || t.toLowerCase().includes(tagSearchQuery.toLowerCase())); const groups: Record<string, string[]> = {}; filteredTags.forEach(tag => { const key = getPinyinGroup(tag); if (!groups[key]) groups[key] = []; groups[key].push(tag); }); const sortedKeys = Object.keys(groups).sort(); return sortedKeys.reduce((obj, key) => { obj[key] = groups[key].sort((a, b) => a.localeCompare(b, state.settings.language)); return obj; }, {} as Record<string, string[]>); }, [state.files, state.settings.language, state.customTags, tagSearchQuery]);
  // Memoized person counts to avoid recalculating every time
  const personCounts = useMemo(() => {
    // 开始记录人员计数性能
    const timer = performance.now();
    const counts = new Map<string, number>();
    
    // Initialize all people with 0 count
    Object.keys(state.people).forEach(personId => {
      counts.set(personId, 0);
    });
    
    // Count files per person
    Object.values(state.files).forEach(file => {
      if (file.type === FileType.IMAGE && file.aiData?.analyzed && file.aiData?.faces) {
        const personIds = new Set(file.aiData.faces.map(face => face.personId));
        personIds.forEach(personId => {
          counts.set(personId, (counts.get(personId) || 0) + 1);
        });
      }
    });
    
    // 记录性能指标
    const duration = performance.now() - timer;
    performanceMonitor.timing('personCounts', duration, {
      personCount: Object.keys(state.people).length,
      fileCount: Object.keys(state.files).length
    });
    
    return counts;
  }, [state.files, state.people]);

  const handleUpdateFile = (id: string, updates: Partial<FileNode>) => { 
    setState(prev => { 
      const updatedFiles = { ...prev.files, [id]: { ...prev.files[id], ...updates } }; 
      
      // Check if we're updating aiData.faces
      if (updates.aiData?.faces || (updates.aiData && prev.files[id].aiData?.faces)) {
        const updatedPeople = { ...prev.people }; 
        
        // Get the current and previous faces
        const currentFaces = updatedFiles[id].aiData?.faces || []; 
        const prevFaces = prev.files[id].aiData?.faces || []; 
        
        // Get person IDs from current and previous faces
        const currentPersonIds = new Set(currentFaces.map(face => face.personId));
        const prevPersonIds = new Set(prevFaces.map(face => face.personId));
        
        // Find added and removed person IDs
        const addedPersonIds = Array.from(currentPersonIds).filter(personId => !prevPersonIds.has(personId));
        const removedPersonIds = Array.from(prevPersonIds).filter(personId => !currentPersonIds.has(personId));
        
        // Update counts for all affected people
        const allAffectedPersonIds = new Set([...addedPersonIds, ...removedPersonIds]);
        
        // Create a copy of the current counts
        const currentCounts = new Map(personCounts);
        
        allAffectedPersonIds.forEach(personId => {
          let newCount = currentCounts.get(personId) || 0;
          
          // Adjust count based on changes
          if (addedPersonIds.includes(personId)) {
            newCount += 1;
          }
          if (removedPersonIds.includes(personId)) {
            newCount = Math.max(0, newCount - 1);
          }
          
          // Update the person's count and cover file if needed
          if (updatedPeople[personId]) {
            const updatedPerson = { ...updatedPeople[personId], count: newCount };
            
            // If person doesn't have a cover file and has a face in current file, set current file as cover
            if (!updatedPerson.coverFileId && currentPersonIds.has(personId)) {
              updatedPerson.coverFileId = id;
              
              // Find the first face for this person in current file
              const faceForPerson = currentFaces.find(face => face.personId === personId);
              if (faceForPerson?.box && faceForPerson.box.w > 0 && faceForPerson.box.h > 0) {
                updatedPerson.faceBox = faceForPerson.box;
              }
            }
            
            updatedPeople[personId] = updatedPerson;
          }
        });
        
        return { ...prev, files: updatedFiles, people: updatedPeople }; 
      }
      
      return { ...prev, files: updatedFiles }; 
    }); 
  };
  
  // Helper function to limit concurrency
  const asyncPool = async function <T>(limit: number, items: T[], fn: (item: T, index: number) => Promise<any>) {
    const results = [];
    const executing: Promise<any>[] = [];
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const p = Promise.resolve().then(() => fn(item, i));
      results.push(p);
      
      if (limit <= items.length) {
        const e = p.then(() => {
          executing.splice(executing.indexOf(e), 1);
        });
        executing.push(e);
        if (executing.length >= limit) {
          await Promise.race(executing);
        }
      }
    }
    
    return Promise.all(results);
  };

  const handleCopyFiles = async (fileIds: string[], targetFolderId: string) => {
      // 开始记录复制操作性能
      const copyTimer = performanceMonitor.start('handleCopyFiles');
      console.log('[CopyFiles] Starting copy operation', { fileIds, targetFolderId });
      const targetFolder = state.files[targetFolderId];
      console.log('[CopyFiles] Target folder info', { targetFolder: targetFolder?.name, targetPath: targetFolder?.path });
      
      if (!targetFolder || !targetFolder.path) {
          console.error('[CopyFiles] Invalid target folder or path');
          // 记录性能指标
          performanceMonitor.end(copyTimer, 'handleCopyFiles', { success: false, fileCount: fileIds.length });
          return;
      }
      
      const taskId = startTask('copy', fileIds, t('tasks.copying'), false); // 禁用自动进度
      console.log('[CopyFiles] Task started with ID', taskId);
      
      const separator = targetFolder.path.includes('/') ? '/' : '\\';
      let copiedCount = 0;
      const scannedFilesMap = new Map<string, any>();
      const filePathsMap = new Map<string, { sourcePath: string; newPath: string; filename: string; originalFile: FileNode }>();
      
      try {
          
          // Precompute all target paths and file info
          for (const id of fileIds) {
              const file = state.files[id];
              if (file && file.path) {
                  const filename = file.name;
                  const newPath = `${targetFolder.path}${separator}${filename}`;
                  filePathsMap.set(id, { sourcePath: file.path, newPath, filename, originalFile: file });
              }
          }
          
          // Parallel copy with limited concurrency (10 files at a time)
          await asyncPool(10, fileIds, async (id, index) => {
              const fileInfo = filePathsMap.get(id);
              if (!fileInfo) return;
              
              try {
                  console.log('[CopyFiles] Copying file', { sourcePath: fileInfo.sourcePath, destPath: fileInfo.newPath });
                  
                  // Use Tauri API directly
                  await copyFile(fileInfo.sourcePath, fileInfo.newPath);
                  
                  // Scan only the newly copied file instead of entire directory
                  console.log('[CopyFiles] Scanning newly copied file:', fileInfo.newPath);
                  const scannedFile = await scanFile(fileInfo.newPath, targetFolderId);
                  
                  // Store scanned file info for batch update
                  scannedFilesMap.set(id, { scannedFile, originalFile: fileInfo.originalFile });
                  
                  // Update progress
                  copiedCount++;
                  console.log('[CopyFiles] Copy count:', copiedCount);
                  // 手动更新任务进度
                  updateTask(taskId, { current: copiedCount });
              } catch (error) {
                  console.error('[CopyFiles] Error processing file ID', id, error);
                  // Continue with other files
              }
          });
          
          // Batch update state with all newly copied files
          if (scannedFilesMap.size > 0) {
              setState(prev => {
                  const newFiles = { ...prev.files };
                  const updatedTargetFolder = { ...newFiles[targetFolderId] };
                  updatedTargetFolder.children = [...(updatedTargetFolder.children || [])];
                  
                  // Process all scanned files
                  scannedFilesMap.forEach(({ scannedFile, originalFile }) => {
                      const existingFile = prev.files[scannedFile.id];
                      
                      if (existingFile) {
                          // Merge preserving user data
                          newFiles[scannedFile.id] = {
                              ...scannedFile,
                              tags: existingFile.tags,
                              description: existingFile.description,
                              url: existingFile.url,
                              aiData: existingFile.aiData,
                              sourceUrl: existingFile.sourceUrl,
                              author: existingFile.author,
                              category: existingFile.category
                          };
                      } else {
                          // New file, add it
                          newFiles[scannedFile.id] = scannedFile;
                      }
                      
                      // Add to target folder's children if not already present
                      if (!updatedTargetFolder.children?.includes(scannedFile.id)) {
                          updatedTargetFolder.children?.push(scannedFile.id);
                      }
                  });
                  
                  // Update target folder
                  newFiles[targetFolderId] = updatedTargetFolder;
                  
                  return { ...prev, files: newFiles };
              });
          }
          
          showToast(t('context.copied'));
          console.log('[CopyFiles] Copy operation completed successfully');
          // 完成任务
          updateTask(taskId, { current: fileIds.length, status: 'completed' });
          // 1秒后移除任务
          setTimeout(() => {
              setState(prev => ({
                  ...prev,
                  tasks: prev.tasks.filter(t => t.id !== taskId)
              }));
          }, 1000);
          
          // 记录成功的性能指标
          performanceMonitor.end(copyTimer, 'handleCopyFiles', { 
              success: true, 
              fileCount: fileIds.length,
              copiedCount: copiedCount 
          });
      } catch (e) {
          console.error('[CopyFiles] Error during copy operation:', e);
          showToast("Copy failed");
          // 任务失败，直接移除
          setTimeout(() => {
              setState(prev => ({
                  ...prev,
                  tasks: prev.tasks.filter(t => t.id !== taskId)
              }));
          }, 1000);
          
          // 记录失败的性能指标
          performanceMonitor.end(copyTimer, 'handleCopyFiles', { 
              success: false, 
              fileCount: fileIds.length,
              copiedCount: copiedCount 
          });
      }
  };

  const handleMoveFiles = async (fileIds: string[], targetFolderId: string) => {
      // 开始记录移动操作性能
      const moveTimer = performanceMonitor.start('handleMoveFiles');
      console.log('[MoveFiles] Starting move operation', { fileIds, targetFolderId });
      
      if (fileIds.includes(targetFolderId)) {
          console.error('[MoveFiles] Cannot move a folder into itself');
          // 记录性能指标
          performanceMonitor.end(moveTimer, 'handleMoveFiles', { success: false, fileCount: fileIds.length });
          return;
      }
      
      const targetFolder = state.files[targetFolderId];
      console.log('[MoveFiles] Target folder info', { targetFolder: targetFolder?.name, targetPath: targetFolder?.path });
      
      if (!targetFolder || !targetFolder.path) {
          console.error('[MoveFiles] Invalid target folder or path');
          // 记录性能指标
          performanceMonitor.end(moveTimer, 'handleMoveFiles', { success: false, fileCount: fileIds.length });
          return;
      }
      
      const taskId = startTask('move', fileIds, t('tasks.moving'), false); // 禁用自动进度
      console.log('[MoveFiles] Task started with ID', taskId);
      
      const separator = targetFolder.path.includes('/') ? '/' : '\\';
      // Collect all unique source parent IDs
      const sourceParentIds = new Set<string>();
      let movedCount = 0;
      
      // Precompute all target paths and file info
      const filePathsMap = new Map<string, { 
          sourcePath: string; 
          newPath: string; 
          filename: string; 
          originalFile: FileNode;
          parentId: string | undefined;
      }>();
      
      try {
          
          for (const id of fileIds) {
              const file = state.files[id];
              if (file && file.path) {
                  const filename = file.name;
                  const newPath = `${targetFolder.path}${separator}${filename}`;
                  filePathsMap.set(id, { 
                      sourcePath: file.path, 
                      newPath, 
                      filename, 
                      originalFile: file,
                      parentId: file.parentId || undefined
                  });
              }
          }
          
          // Check for existing files before performing file system operations - Parallel check
          console.log('[MoveFiles] Checking for existing files in parallel');
          let existingFiles: string[] = [];
          
          // Parallel file existence check
          await asyncPool(20, fileIds, async (id) => {
              const fileInfo = filePathsMap.get(id);
              if (!fileInfo) return;
              
              try {
                  // Use Tauri API to check if file exists
                  const exists = await invoke<boolean>('file_exists', { filePath: fileInfo.newPath });
                  if (exists) {
                      existingFiles.push(fileInfo.filename);
                  }
              } catch (error) {
                  console.error('[MoveFiles] Error checking file existence for', fileInfo.filename, error);
              }
          });
          
          // If any files exist at destination, show confirmation modal
          if (existingFiles.length > 0) {
              console.log('[MoveFiles] Found existing files, showing confirmation');
              // Create a promise that resolves when user confirms or rejects
              await new Promise<void>((resolve, reject) => {
                  setState(prev => ({
                      ...prev,
                      activeModal: {
                          type: 'confirm-overwrite-file',
                          data: {
                              files: existingFiles,
                              onConfirm: () => {
                                  setState(s => ({ ...s, activeModal: { type: null } }));
                                  resolve();
                              },
                              onCancel: () => {
                                  setState(s => ({ ...s, activeModal: { type: null } }));
                                  reject(new Error('User cancelled move operation'));
                              }
                          }
                      }
                  }));
              });
          }
          
          // Perform actual file system operations - Parallel move with limited concurrency
          console.log('[MoveFiles] Performing actual file system operations in parallel');
          
          await asyncPool(10, fileIds, async (id) => {
              const fileInfo = filePathsMap.get(id);
              if (!fileInfo) return;
              
              try {
                  console.log('[MoveFiles] Moving file', { sourcePath: fileInfo.sourcePath, destPath: fileInfo.newPath });
                  
                  // Use Tauri API directly
                  await moveFile(fileInfo.sourcePath, fileInfo.newPath);
                  console.log('[MoveFiles] File moved successfully');
                  
                  movedCount++;
                  console.log('[MoveFiles] Move count:', movedCount);
                  // 手动更新任务进度
                  updateTask(taskId, { current: movedCount });
              } catch (error) {
                  console.error('[MoveFiles] Error processing file ID', id, error);
                  // Continue with other files
              }
          });
          
          // Update local state after file system operations are complete
          console.log('[MoveFiles] Updating state after file system operations');
          setState(prev => {
              console.log('[MoveFiles] State update callback called');
              const newFiles = { ...prev.files };
              const updatedTargetFolder = { ...newFiles[targetFolderId] };
              updatedTargetFolder.children = [...(updatedTargetFolder.children || [])];
              
              // Track source parents that need their children updated
              const sourceParentsToUpdate = new Map<string, any>();
              
              // Process all files in batch
              for (const id of fileIds) {
                  const fileInfo = filePathsMap.get(id);
                  const file = newFiles[id];
                  if (!fileInfo || !file || !file.path) continue;
                  
                  console.log('[MoveFiles] Processing file ID in state update', id);
                  
                  // Get source parent
                  if (fileInfo.parentId) {
                      sourceParentIds.add(fileInfo.parentId);
                      if (!sourceParentsToUpdate.has(fileInfo.parentId)) {
                          const sourceParent = newFiles[fileInfo.parentId];
                          if (sourceParent) {
                              sourceParentsToUpdate.set(fileInfo.parentId, {
                                  ...sourceParent,
                                  children: [...(sourceParent.children || [])]
                              });
                          }
                      }
                  }
                  
                  // Update file's parent and path
                  const newPath = `${updatedTargetFolder.path}${separator}${fileInfo.filename}`;
                  console.log('[MoveFiles] Updating file state', { fileId: id, oldParent: fileInfo.parentId, newParent: targetFolderId, oldPath: file.path, newPath });
                  
                  // Check if target folder already has a file with the same name
                  const existingFileId: string | undefined = updatedTargetFolder.children.find(childId => {
                      const childFile = newFiles[childId];
                      return childFile && childFile.name === fileInfo.filename;
                  });
                  
                  // If existing file found, remove it from target folder's children and files map
                  if (existingFileId) {
                      console.log('[MoveFiles] Removing existing file from target folder', { existingFileId, filename: fileInfo.filename });
                      // Remove from target folder's children array
                      updatedTargetFolder.children = updatedTargetFolder.children.filter((childId: string) => childId !== existingFileId);
                      // Remove from files map
                      delete newFiles[existingFileId];
                  }
                  
                  newFiles[id] = {
                      ...file,
                      parentId: targetFolderId,
                      path: newPath
                  };
                  
                  // Add to target folder's children
                  updatedTargetFolder.children.push(id);
                  console.log('[MoveFiles] Added file to target folder children');
                  
                  // Remove from source parent's children
                  if (fileInfo.parentId && sourceParentsToUpdate.has(fileInfo.parentId)) {
                      const sourceParent = sourceParentsToUpdate.get(fileInfo.parentId);
                      sourceParent.children = sourceParent.children.filter((childId: string) => childId !== id);
                      console.log('[MoveFiles] Removed file from source parent children');
                  }
              }
              
              // Apply source parent updates
              sourceParentsToUpdate.forEach((updatedParent, parentId) => {
                  newFiles[parentId] = updatedParent;
                  console.log('[MoveFiles] Updated source parent', parentId);
              });
              
              // Apply target folder update
              newFiles[targetFolderId] = updatedTargetFolder;
              console.log('[MoveFiles] Updated target folder', targetFolderId);
              
              return {
                  ...prev,
                  files: newFiles
              };
          });
          
          showToast(t('context.moved'));
          console.log('[MoveFiles] Move operation completed successfully');
          // 完成任务
          updateTask(taskId, { current: fileIds.length, status: 'completed' });
          // 1秒后移除任务
          setTimeout(() => {
              setState(prev => ({
                  ...prev,
                  tasks: prev.tasks.filter(t => t.id !== taskId)
              }));
          }, 1000);
          
          // 记录成功的性能指标
          performanceMonitor.end(moveTimer, 'handleMoveFiles', { 
              success: true, 
              fileCount: fileIds.length,
              movedCount: movedCount 
          });
      } catch (e) {
          console.error('[MoveFiles] Error during move operation:', e);
          showToast("Move failed");
          // 任务失败，直接移除
          setTimeout(() => {
              setState(prev => ({
                  ...prev,
                  tasks: prev.tasks.filter(t => t.id !== taskId)
              }));
          }, 1000);
          
          // 记录失败的性能指标
          performanceMonitor.end(moveTimer, 'handleMoveFiles', { 
              success: false, 
              fileCount: fileIds.length,
              movedCount: movedCount 
          });
      }
  };

  // 处理拖拽放置到文件夹的回调（来自FileGrid和TreeSidebar）
  // External drag and drop handlers
  // State to track the number of drag enter events (to handle nested elements)
  const [dragEnterCounter, setDragEnterCounter] = useState(0);
  
  // 检测拖拽到外部的处理函数
  const handleWindowDragLeave = async () => {
    // 检查是否处于内部拖拽状态
    if (isDraggingInternal && draggedFilePaths.length > 0) {
      try {
        // 导入Tauri的API
        const { copyFile } = await import('./api/tauri-bridge');
        
        // 使用Windows原生API复制文件
        for (const filePath of draggedFilePaths) {
          // 这里需要获取目标路径，我们可以使用save dialog让用户选择，或者默认复制到桌面
          // 为了简化，我们暂时不实现文件选择，而是通过拖拽到外部时自动处理
          // 在实际应用中，我们需要使用系统级的拖拽API来获取目标路径
          console.log('Would copy file:', filePath);
        }
        
        // 显示控制台通知
        console.log(`已复制 ${draggedFilePaths.length} 个文件`);
      } catch (error) {
        console.error('Error copying files:', error);
      } finally {
        // 清除拖拽状态
        setIsDraggingInternal(false);
        setDraggedFilePaths([]);
      }
    }
  };

  const handleExternalDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Check if this is an internal drag (from within the app)
    // Internal drags set 'application/json' type with internalDrag flag
    // Also check isDraggingInternal state for Alt+drag operations using tauri-plugin-drag
    const isInternalDrag = e.dataTransfer.types.includes('application/json') || isDraggingInternal;
    
    // Only show overlay for external drags (files from outside the app)
    if (e.dataTransfer.types.includes('Files') && !isInternalDrag && !isExternalDragging) {
      // Only set the state if we're not already dragging
      setIsExternalDragging(true);
      // Update file count from dataTransfer.items
      const fileCount = e.dataTransfer.items.length;
      // Create placeholder array to show file count
      setExternalDragItems(Array(fileCount).fill('placeholder'));
      setExternalDragPosition({ x: e.clientX, y: e.clientY });
    }
  };

  const handleExternalDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (isExternalDragging) {
      setExternalDragPosition({ x: e.clientX, y: e.clientY });
    }
  };

  const handleExternalDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!isExternalDragging) return;
    
    // 保存当前选择的操作
    const action = hoveredDropAction;
    
    // 立即隐藏拖拽覆盖界面
    setIsExternalDragging(false);
    setExternalDragItems([]);
    setExternalDragPosition(null);
    setHoveredDropAction(null);
    
    // 如果没有悬停在复制区域，不执行任何操作
    if (!action) {
      console.log('[ExternalDrag] Not hovering on copy zone, ignoring drop');
      return;
    }
    
    try {
      // In Tauri, we cannot get full file paths from external drag events
      // Instead, we need to read the file contents and write them to the destination
      const files = Array.from(e.dataTransfer.files);
      
      if (files.length === 0) {
        console.warn('[ExternalDrag] No files found in drag event');
        return;
      }
      
      // 执行复制操作
      await handleExternalCopyFiles(files);
    } catch (error) {
      console.error('Error handling external drop:', error);
      showToast(t('errors.dropFailed'));
    }
  };

  const handleExternalDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Check if the mouse is actually leaving the window
    // by checking if the relatedTarget is null or outside the document
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsExternalDragging(false);
      setExternalDragItems([]);
      setExternalDragPosition(null);
      setHoveredDropAction(null);
      
      // 检查是否拖拽到了外部
      handleWindowDragLeave();
    }
  };

  // External file operations - using File objects instead of paths
  const handleExternalCopyFiles = async (files: File[]) => {
    const activeTab = state.tabs.find(tab => tab.id === state.activeTabId);
    if (!activeTab || !activeTab.folderId) return;
    
    const targetFolder = state.files[activeTab.folderId];
    if (!targetFolder || targetFolder.type !== FileType.FOLDER) return;
    
    // Start background task
    const taskId = startTask('copy', [], t('tasks.copying'), false);
    updateTask(taskId, { total: files.length, current: 0 });
    
    try {
      
      console.log('[ExternalCopy] Starting copy operation:', { fileCount: files.length, targetFolder: targetFolder.name, targetPath: targetFolder.path });
      
      // Save folder ID to local variable for use in async operations
      const targetFolderId = activeTab.folderId;
      
      // Process each file individually - copy, scan, and update UI immediately after each file
      let current = 0;
      for (const file of files) {
        const destPath = `${targetFolder.path}${targetFolder.path.includes('\\') ? '\\' : '/'}${file.name}`;
        
        try {
          // Read file content as ArrayBuffer
          const arrayBuffer = await file.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          
          // Write file to destination
          console.log('[ExternalCopy] Copying file:', { fileName: file.name, destPath });
          await writeFileFromBytes(destPath, bytes);
          console.log('[ExternalCopy] File copied successfully');
          
          // Scan the new file immediately
          console.log('[ExternalCopy] Scanning new file:', file.name);
          const scannedFile = await scanFile(destPath, targetFolderId);
          
          // Update state with the new file immediately after copying and scanning
          setState(prev => {
            const newFiles = { ...prev.files };
            const existingFile = prev.files[scannedFile.id];
            
            if (existingFile) {
              // Merge preserving user data
              newFiles[scannedFile.id] = {
                ...scannedFile,
                tags: existingFile.tags,
                description: existingFile.description,
                url: existingFile.url,
                aiData: existingFile.aiData,
                sourceUrl: existingFile.sourceUrl,
                author: existingFile.author,
                category: existingFile.category
              };
            } else {
              // New file, add it
              newFiles[scannedFile.id] = scannedFile;
            }
            
            // Update target folder's children list
            const currentFolder = newFiles[targetFolderId];
            if (currentFolder) {
              const existingChildren = currentFolder.children || [];
              if (!existingChildren.includes(scannedFile.id)) {
                newFiles[targetFolderId] = {
                  ...currentFolder,
                  children: [...existingChildren, scannedFile.id]
                };
              }
            }
            
            return { ...prev, files: newFiles };
          });
        } catch (error) {
          console.error(`[ExternalCopy] Failed to copy or scan file ${file.name}:`, error);
          // Continue with other files even if one fails
        } finally {
          // Update task progress after each file is processed (whether successful or not)
          current++;
          updateTask(taskId, { current });
        }
      }
      
      // Complete task
      updateTask(taskId, { status: 'completed', current: files.length });
      
      // Show success toast
      showToast(t('context.copied'));
      
      // Auto-remove task after 1 second
      setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 1000);
      console.log('[ExternalCopy] Copy operation completed successfully');
    } catch (error) {
      console.error('[ExternalCopy] Failed to copy external items:', error);
      updateTask(taskId, { status: 'completed' });
      showToast(t('errors.copyFailed'));
      
      // Auto-remove task after 1 second
      setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 1000);
    }
  };

  const handleExternalMoveFiles = async (files: File[], dataTransfer?: DataTransfer) => {
    const activeTab = state.tabs.find(tab => tab.id === state.activeTabId);
    if (!activeTab || !activeTab.folderId) return;
    
    const targetFolder = state.files[activeTab.folderId];
    if (!targetFolder || targetFolder.type !== FileType.FOLDER) return;
    
    // Start background task
    const taskId = startTask('move', [], t('tasks.moving'), false);
    updateTask(taskId, { total: files.length, current: 0 });
    
    try {
      
      console.log('[ExternalMove] Starting move operation:', { fileCount: files.length, targetFolder: targetFolder.name, targetPath: targetFolder.path });
      
      // First copy files to destination
      let current = 0;
      for (const file of files) {
        const destPath = `${targetFolder.path}${targetFolder.path.includes('\\') ? '\\' : '/'}${file.name}`;
        
        // Read file content as ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        
        // Write file to destination
        console.log('[ExternalMove] Moving file:', { fileName: file.name, destPath });
        await writeFileFromBytes(destPath, bytes);
        console.log('[ExternalMove] File moved successfully');
        
        // Update task progress
        current++;
        updateTask(taskId, { current });
      }
      
      console.log('[ExternalMove] Scanning new files individually (performance optimized)');
      // Scan only the new files individually instead of scanning entire directory
      // This is much faster for large directories
      
      // Save folder ID to local variable for use in async operations
      const targetFolderId = activeTab.folderId;
      
      // Scan each new file individually
      for (const file of files) {
        const destPath = `${targetFolder.path}${targetFolder.path.includes('\\') ? '\\' : '/'}${file.name}`;
        try {
          const scannedFile = await scanFile(destPath, targetFolderId);
          
          // Update state with the new file
          setState(prev => {
            const newFiles = { ...prev.files };
            const existingFile = prev.files[scannedFile.id];
            
            if (existingFile) {
              // Merge preserving user data
              newFiles[scannedFile.id] = {
                ...scannedFile,
                tags: existingFile.tags,
                description: existingFile.description,
                url: existingFile.url,
                aiData: existingFile.aiData,
                sourceUrl: existingFile.sourceUrl,
                author: existingFile.author,
                category: existingFile.category
              };
            } else {
              // New file, add it
              newFiles[scannedFile.id] = scannedFile;
            }
            
            // Update target folder's children list
            const currentFolder = newFiles[targetFolderId];
            if (currentFolder) {
              const existingChildren = currentFolder.children || [];
              if (!existingChildren.includes(scannedFile.id)) {
                newFiles[targetFolderId] = {
                  ...currentFolder,
                  children: [...existingChildren, scannedFile.id]
                };
              }
            }
            
            return { ...prev, files: newFiles };
          });
        } catch (error) {
          console.error(`[ExternalMove] Failed to scan file ${file.name}:`, error);
          // Continue with other files even if one fails
        }
      }
      
      // Show success toast
      // Show success toast
      showToast(t('context.moved'));
      console.log('[ExternalMove] Move operation completed successfully');
    } catch (error) {
      console.error('[ExternalMove] Failed to move external items:', error);
      // Complete task
      updateTask(taskId, { status: 'completed' });
      
      // Show error toast
      showToast(t('errors.moveFailed'));
      
      // Auto-remove task after 1 second
      setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 1000);
    }
  };

  const handleDropOnFolder = async (targetFolderId: string, sourceIds: string[]) => {
      // 过滤掉目标文件夹本身和无效的ID
      const validIds = sourceIds.filter(id => id !== targetFolderId && state.files[id]);
      
      if (validIds.length === 0) {
          return;
      }
      
      // 检查目标是否是文件夹
      const targetFolder = state.files[targetFolderId];
      if (!targetFolder || targetFolder.type !== FileType.FOLDER) {
          return;
      }
      
      // 检查是否所有文件都已经在目标文件夹中
      const allFilesInTarget = validIds.every(id => {
          const file = state.files[id];
          return file && file.parentId === targetFolderId;
      });
      
      if (allFilesInTarget) {
          return;
      }
      
      // 过滤掉已经在目标文件夹中的文件
      const filesToMove = validIds.filter(id => {
          const file = state.files[id];
          return file && file.parentId !== targetFolderId;
      });
      
      if (filesToMove.length === 0) {
          return;
      }
      
      // 调用已有的handleMoveFiles函数
      await handleMoveFiles(filesToMove, targetFolderId);
  };

  const handleBatchRename = (pattern: string, startNum: number) => { /* ... */ }; 
  
  const handleCopyImageToClipboard = async (fileId: string) => {
      const file = state.files[fileId];
      if (!file || file.type !== FileType.IMAGE) return;
      // TODO: Implement copyImage for Tauri
      showToast(t('context.imageCopied'));
  };

  const handleDropOnTag = (tag: string, sourceIds: string[]) => { /* ... */ };
  const startRename = (id: string) => setState(s => ({ ...s, renamingId: id }));
  const handleResolveExtensionChange = (id: string, name: string) => handleUpdateFile(id, { name });
  const handleResolveFileCollision = (fileId: string, desiredName: string) => { /* ... */ };
  const handleResolveFolderMerge = (sourceId: string, targetId: string) => { /* ... */ };
  
  const requestDeleteTags = (tags: string[]) => {
      setState(s => ({ ...s, activeModal: { type: 'confirm-delete-tag', data: { tags } } }));
  };
  
  const handleConfirmDeleteTags = (tags: string[]) => {
      setState(prev => {
          const newFiles = { ...prev.files };
          const newCustomTags = prev.customTags.filter(tag => !tags.includes(tag));
          
          // Update all files that use the deleted tags
          Object.values(newFiles).forEach(file => {
              if (file.tags) {
                  file.tags = file.tags.filter(tag => !tags.includes(tag));
              }
          });
          
          return {
              ...prev,
              files: newFiles,
              customTags: newCustomTags
          };
      });
  };
  
  const handleCopyTags = (ids: string[]) => {
      const allTags = new Set<string>();
      ids.forEach(id => state.files[id]?.tags.forEach(t => allTags.add(t)));
      setState(s => ({ ...s, clipboard: { action: 'copy', items: { type: 'tag', ids: Array.from(allTags) } } }));
      showToast(t('context.copied'));
  };

  const handlePasteTags = (targetIds: string[]) => {
      if (state.clipboard.items.type !== 'tag') return;
      const tagsToAdd = state.clipboard.items.ids;
      setState(prev => {
          const newFiles = { ...prev.files };
          targetIds.forEach(id => {
              const file = newFiles[id];
              if (file) {
                  const newTags = Array.from(new Set([...file.tags, ...tagsToAdd]));
                  newFiles[id] = { ...file, tags: newTags };
              }
          });
          return { ...prev, files: newFiles };
      });
      showToast("Tags pasted");
  };

  const handleCreateNewTag = () => { 
      setIsCreatingTag(true); 
      if (!state.layout.isSidebarVisible) {
          setState(s => ({ ...s, layout: { ...s.layout, isSidebarVisible: true } })); 
      }
  };

  const handleSaveNewTag = (name: string) => { 
      if (name && name.trim()) { 
          const tag = name.trim(); 
          if (!state.customTags.includes(tag)) {
              setState(s => ({ ...s, customTags: [...s.customTags, tag] })); 
          }
      } 
      setIsCreatingTag(false); 
  };

  const handleCancelCreateTag = () => {
      setIsCreatingTag(false);
  };

  const handleOverviewTagClick = (tag: string, e: React.MouseEvent) => {
      e.stopPropagation();
      
      const isCtrl = e.ctrlKey || e.metaKey; // Ctrl for Windows/Linux, Command for macOS
      const isShift = e.shiftKey;
      
      let newSelectedTagIds: string[];
      
      // Get all tags in the current view, sorted
      const allTags = groupedTags ? Object.values(groupedTags).flat() : [];
      
      if (isCtrl) {
        // Ctrl+Click: Toggle selection of this tag
        if (activeTab.selectedTagIds.includes(tag)) {
          // Remove from selection
          newSelectedTagIds = activeTab.selectedTagIds.filter(tagId => tagId !== tag);
        } else {
          // Add to selection
          newSelectedTagIds = [...activeTab.selectedTagIds, tag];
        }
      } else if (isShift && activeTab.selectedTagIds.length > 0) {
        // Shift+Click: Select range from last selected to current
        const lastSelectedTag = activeTab.selectedTagIds[activeTab.selectedTagIds.length - 1];
        const lastIndex = allTags.indexOf(lastSelectedTag);
        const currentIndex = allTags.indexOf(tag);
        
        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex);
          const end = Math.max(lastIndex, currentIndex);
          newSelectedTagIds = allTags.slice(start, end + 1);
        } else {
          newSelectedTagIds = [tag];
        }
      } else {
        // Normal click: Select only this tag
        newSelectedTagIds = [tag];
      }
      
      updateActiveTab({ selectedTagIds: newSelectedTagIds });
  };
  
  const handleTagClick = (tag: string, e: React.MouseEvent) => {
       e.stopPropagation();
       closeContextMenu();
       updateActiveTab({ activeTags: [tag] });
  };

  const handlePersonClick = (personId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      
      closeContextMenu();
      
      // If we just finished a selection box operation, don't process the click
      if (isSelecting) return;
      
      const isCtrl = e.ctrlKey || e.metaKey; // Ctrl for Windows/Linux, Command for macOS
      const isShift = e.shiftKey;
      
      let newSelectedPersonIds: string[];
      let newLastSelectedId: string = personId;
      
      // Get all people in the current view, in the same order as displayed in the grid
      // Match the order used in FileGrid's useLayout function for people-overview
      let allPeople = Object.values(state.people);
      
      // Apply search filter if present, same as in FileGrid
      if (activeTab.searchQuery && activeTab.searchQuery.trim()) {
        const query = activeTab.searchQuery.toLowerCase().trim();
        allPeople = allPeople.filter(person => 
            person.name.toLowerCase().includes(query)
        );
      }
      
      // Sort people alphabetically by name, same as in useLayout
      allPeople.sort((a, b) => a.name.localeCompare(b.name));
      
      const allPersonIds = allPeople.map(person => person.id);
      
      if (isCtrl) {
        // Ctrl+Click: Toggle selection of this person
        if (activeTab.selectedPersonIds.includes(personId)) {
          // Remove from selection
          newSelectedPersonIds = activeTab.selectedPersonIds.filter(id => id !== personId);
        } else {
          // Add to selection
          newSelectedPersonIds = [...activeTab.selectedPersonIds, personId];
        }
        // Always set lastSelectedId to current click, same as file handling
        newLastSelectedId = personId;
      } else if (isShift) {
        // Shift+Click: Select range from last selected to current
        let lastSelectedId = activeTab.lastSelectedId;
        
        // If no lastSelectedId, use the first selected person or current person
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
        // Normal click: Select only this person
        newSelectedPersonIds = [personId];
      }
      
      updateActiveTab({ 
        selectedPersonIds: newSelectedPersonIds,
        lastSelectedId: newLastSelectedId
      });
  };

  const handleRenameTag = (oldTag: string, newTag: string) => {
      if (!newTag.trim() || oldTag === newTag) return;
      
      const trimmedNewTag = newTag.trim();
      
      setState(prev => {
          const newFiles = { ...prev.files };
          let newCustomTags = [...prev.customTags];
          
          // Update all files that use the old tag
          Object.values(newFiles).forEach(file => {
              if (file.tags && file.tags.includes(oldTag)) {
                  file.tags = file.tags.map(tag => tag === oldTag ? trimmedNewTag : tag);
              }
          });
          
          // Update custom tags list
          if (newCustomTags.includes(oldTag)) {
              newCustomTags = newCustomTags.map(tag => tag === oldTag ? trimmedNewTag : tag);
          }
          
          // Update tabs with tag references
          const newTabs = prev.tabs.map(tab => {
              let updatedTab = { ...tab };
              
              // Update tab's search query if it's searching for the old tag
              if (updatedTab.searchQuery === oldTag) {
                  updatedTab.searchQuery = trimmedNewTag;
              }
              
              // Update tab's active tags if the old tag is active
              if (updatedTab.activeTags.includes(oldTag)) {
                  updatedTab.activeTags = updatedTab.activeTags.map(tag => tag === oldTag ? trimmedNewTag : tag);
              }
              
              // Update tab's selected tag ids if the old tag is selected
              if (updatedTab.selectedTagIds.includes(oldTag)) {
                  updatedTab.selectedTagIds = updatedTab.selectedTagIds.map(tag => tag === oldTag ? trimmedNewTag : tag);
              }
              
              return updatedTab;
          });
          
          return {
              ...prev,
              files: newFiles,
              customTags: newCustomTags,
              tabs: newTabs,
              activeModal: { type: null }
          };
      });
  };
  
  const handleRenamePerson = (personId: string, newName: string) => {
      if (!newName.trim()) return;
      setState(prev => ({
          ...prev,
          people: {
              ...prev.people,
              [personId]: { ...prev.people[personId], name: newName }
          },
          activeModal: { type: null }
      }));
  };

  const handleUpdatePerson = (personId: string, updates: Partial<Person>) => {
      setState(prev => ({
          ...prev,
          people: {
              ...prev.people,
              [personId]: { ...prev.people[personId], ...updates }
          }
      }));
  };

  const handleCreatePerson = () => {
      const newId = Math.random().toString(36).substr(2, 9);
      const newPerson: Person = {
          id: newId,
          name: t('context.newPersonDefault'),
          coverFileId: '',
          count: 0,
          description: ''
      };
      setState(prev => ({
          ...prev,
          people: { ...prev.people, [newId]: newPerson },
          activeModal: { type: 'rename-person', data: { personId: newId } }
      }));
  };

  const handleDeletePerson = async (personId: string | string[]) => {
      const idsToDelete = typeof personId === 'string' ? [personId] : personId;

      // Work on local copies first
      const prevState = state;
      const newPeople: Record<string, Person> = { ...prevState.people };
      const newFiles: Record<string, FileNode> = { ...prevState.files };

      // Remove people from map
      idsToDelete.forEach(id => delete newPeople[id]);

      // Remove faces associated with deleted people from files
      Object.keys(newFiles).forEach(fid => {
          const file = newFiles[fid];
          if (file && file.type === FileType.IMAGE && file.aiData?.faces) {
              const filtered = file.aiData.faces.filter(face => !idsToDelete.includes(face.personId));
              if (filtered.length !== file.aiData.faces.length) {
                  // Update aiData (create shallow copies to keep immutability)
                  newFiles[fid] = { ...file, aiData: { ...file.aiData, faces: filtered } };
              }
          }
      });

      // Recompute counts for remaining people
      const counts = new Map<string, number>();
      Object.values(newFiles).forEach(f => {
          if (f.type === FileType.IMAGE && f.aiData?.faces) {
              f.aiData.faces.forEach(face => {
                  counts.set(face.personId, (counts.get(face.personId) || 0) + 1);
              });
          }
      });

      // Apply new counts to people
      Object.keys(newPeople).forEach(pid => {
          const p = newPeople[pid];
          newPeople[pid] = { ...p, count: counts.get(pid) || 0 };
      });

      // Update front-end state immediately
      setState(prev => ({ ...prev, people: newPeople, files: newFiles, activeModal: { type: null } }));

      // Persist deletion and updated counts to DB
      try {
          // Delete persons from DB
          await Promise.all(idsToDelete.map(id => dbDeletePerson(id)));

          // Upsert remaining people counts to DB (only those whose count changed)
          const upserts = Object.values(newPeople).map(p => ({
              id: p.id,
              name: p.name,
              coverFileId: p.coverFileId || '',
              count: p.count || 0,
              description: p.description || null,
              faceBox: p.faceBox || null,
              updatedAt: Date.now()
          }));
          await Promise.all(upserts.map(u => dbUpsertPerson(u)));

          showToast(t('context.deletedItems').replace('{count}', idsToDelete.length.toString()));
      } catch (err) {
          console.error('Failed to persist person deletions:', err);
          showToast('Failed to persist deletion to database');
      }
  };

  const handleManualAddPerson = (personId: string) => {
      const fileIds = activeTab.selectedFileIds;
      if (fileIds.length === 0) {
          setState(s => ({ ...s, activeModal: { type: null } }));
          return;
      }
      setState(prev => {
          const newFiles = { ...prev.files };
          const newPeople = { ...prev.people };
          const person = newPeople[personId];
          if (!person) return prev;
          
          let updated = false;
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
                      updated = true;
                  }
              }
          });
          
          if (updated) {
              // 一次性更新人物的count
              newPeople[personId] = {
                  ...person,
                  count: person.count + countIncrease,
                  coverFileId: person.coverFileId || fileIds[0] 
              };
              
              return { ...prev, files: newFiles, people: newPeople, activeModal: { type: null } };
          }
          return { ...prev, activeModal: { type: null } };
      });
      showToast(t('context.saved'));
  };

  const handleManualAddToTopic = (topicId: string) => {
      // Get IDs from modal data or active selection
      let targetFileIds: string[] = [];
      let targetPersonIds: string[] = [];
      
      // Check modal data first
      if (state.activeModal.type === 'add-to-topic' && state.activeModal.data) {
          if (state.activeModal.data.fileIds) targetFileIds = state.activeModal.data.fileIds;
          if (state.activeModal.data.personIds) targetPersonIds = state.activeModal.data.personIds;
      }
      
      // Fallback to active selection if modal data is empty/null
      if (targetFileIds.length === 0 && targetPersonIds.length === 0) {
           if (activeTab.viewMode === 'people-overview') {
               targetPersonIds = activeTab.selectedPersonIds;
           } else {
               targetFileIds = activeTab.selectedFileIds;
           }
      }

      if (targetFileIds.length === 0 && targetPersonIds.length === 0) {
           setState(s => ({ ...s, activeModal: { type: null } }));
           return;
      }

      setState(current => {
          const topic = current.topics[topicId];
          if (!topic) return current;

          const updatedTopic = { ...topic };
          
          if (targetFileIds.length > 0) {
              const existingFiles = new Set(updatedTopic.fileIds || []);
              targetFileIds.forEach(id => existingFiles.add(id));
              updatedTopic.fileIds = Array.from(existingFiles);
          }

          if (targetPersonIds.length > 0) {
              const existingPeople = new Set(updatedTopic.peopleIds || []);
              targetPersonIds.forEach(id => existingPeople.add(id));
              updatedTopic.peopleIds = Array.from(existingPeople);
          }
          
          updatedTopic.updatedAt = new Date().toISOString();

          return {
              ...current,
              topics: {
                  ...current.topics,
                  [topicId]: updatedTopic
              },
              activeModal: { type: null }
          };
      });
      showToast(t('context.saved'));
  };

  // Handle close confirmation actions
  const handleCloseConfirmation = async (action: 'minimize' | 'exit', alwaysAsk: boolean) => {
    setShowCloseConfirmation(false);
    
    // Determine the exit action to save
    // If alwaysAsk is true: keep as 'ask' (always show confirmation)
    // If alwaysAsk is false: save the selected action (minimize or exit)
    const exitActionToSave: 'ask' | 'minimize' | 'exit' = alwaysAsk ? 'ask' : action;
    
    // Update state
    const newSettings = {
      ...state.settings,
      exitAction: exitActionToSave
    };
    
    // Update state and ref immediately
    setState(prev => ({
      ...prev,
      settings: newSettings
    }));
    
    // Immediately update ref to ensure event listener uses the latest value
    exitActionRef.current = exitActionToSave;
    
    // Immediately save the settings to ensure persistence
    try {
      const rootPaths = state.roots.map(id => state.files[id]?.path).filter(Boolean);
      await saveUserData({
        rootPaths,
        customTags: state.customTags,
        people: state.people,
        folderSettings: state.folderSettings,
        settings: newSettings,
        fileMetadata: {}
      });
    } catch (error) {
      console.error('Failed to save exit action preference:', error);
    }
    
    // Perform the selected action
    switch (action) {
      case 'minimize':
        await hideWindow();
        break;
      case 'exit':
        // Exit the application
        await exitApp();
        break;
    }
  };

  // Enhanced handleClearPersonInfo to support selective clearing
  const handleClearPersonInfo = (fileIds: string[], personIdsToClear?: string[]) => {
      setState(prev => {
          const newFiles = { ...prev.files };
          const newPeople = { ...prev.people };
          let updated = false;
          
          // 首先收集所有要清除的人脸所属的人物ID
          const personIdsToUpdate = new Set<string>();
          
          // 清除文件的人脸信息
          fileIds.forEach(fid => {
              const file = newFiles[fid];
              if (file && file.type === FileType.IMAGE && file.aiData?.faces) {
                  let updatedFaces: AiFace[];
                  
                  if (personIdsToClear && personIdsToClear.length > 0) {
                      // 选择性清除指定人物的人脸信息
                      updatedFaces = file.aiData.faces.filter(face => !personIdsToClear.includes(face.personId));
                  } else {
                      // 清除所有人脸信息
                      updatedFaces = [];
                  }
                  
                  // 检查是否有变化
                  if (updatedFaces.length !== file.aiData.faces.length) {
                      // 保存要更新的人物ID
                      file.aiData.faces.forEach(face => {
                          personIdsToUpdate.add(face.personId);
                      });
                      updatedFaces.forEach(face => {
                          personIdsToUpdate.add(face.personId);
                      });
                      
                      // 更新人脸信息
                      const newAiData = { ...file.aiData, faces: updatedFaces };
                      newFiles[fid] = { ...file, aiData: newAiData };
                      updated = true;
                  }
              }
          });
          
          // 更新受影响人物的count
          if (updated) {
              // 重新计算所有受影响人物的count
              personIdsToUpdate.forEach(personId => {
                  let newCount = 0;
                  // 遍历所有文件，计算包含该人物的文件数量
                  Object.values(newFiles).forEach(file => {
                      if (file.type === FileType.IMAGE && file.aiData?.faces) {
                          if (file.aiData.faces.some(face => face.personId === personId)) {
                              newCount++;
                          }
                      }
                  });
                  // 更新人物count
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

  const handleSaveAvatarCrop = (personId: string, box: {x: number, y: number, w: number, h: number, imageId?: string | null}) => {
      const updates: Partial<Person> = { faceBox: box };
      
      // 如果选择了新的图片，更新coverFileId
      if (box.imageId) {
          updates.coverFileId = box.imageId;
      }
      
      handleUpdatePerson(personId, updates);
      setState(s => ({ ...s, activeModal: { type: null } }));
      showToast(t('context.saved'));
  };

  const toggleSettings = () => setState(s => ({ ...s, isSettingsOpen: !s.isSettingsOpen }));
  
  const handleChangePath = async (type: 'resource') => {
      try {
          const selectedPath = await openDirectory();
          if (!selectedPath) {
              return;
          }
          
          // 确保缓存目录存在（在资源根目录下创建 .Aurora_Cache 文件夹）
          if (isTauriEnvironment()) {
              // 计算缓存路径
              const cachePath = `${selectedPath}${selectedPath.includes('\\') ? '\\' : '/'}.Aurora_Cache`;
              await ensureDirectory(cachePath);
          }
          
          const newSettings = {
              ...state.settings,
              paths: {
                  ...state.settings.paths,
                  resourceRoot: selectedPath,
                  // 清除 cacheRoot，因为现在它总是从 resourceRoot 计算
                  cacheRoot: ''
              }
          };
          
          setState(prev => ({
              ...prev,
              settings: newSettings
          }));
          
          startTask('ai', [], t('tasks.processing')); 
          const result = await scanDirectory(selectedPath);
          
          setState(prev => {
               const newRoots = result.roots;
               const newFiles = result.files;
               const newRootId = newRoots.length > 0 ? newRoots[0] : '';
               if (!newRootId) return prev;
               const newTab: TabState = { 
                   ...DUMMY_TAB, 
                   id: Math.random().toString(36).substr(2, 9),
                   folderId: newRootId,
                   history: { 
                       stack: [{ 
                           folderId: newRootId, 
                           viewingId: null, 
                           viewMode: 'browser', 
                           searchQuery: '', 
                           searchScope: 'all', 
                           activeTags: [], 
                           activePersonId: null 
                       }], 
                       currentIndex: 0 
                   } 
               };
               return {
                   ...prev,
                   roots: newRoots,
                   files: newFiles,
                   expandedFolderIds: [newRootId],
                   tabs: [newTab],
                   activeTabId: newTab.id,
                   settings: newSettings
               };
          });
          
          // 重要：在扫描目录并更新 state 后，再保存数据
          // 使用扫描结果中的路径，确保包含新设置的目录
          const resultRootPaths = result.roots.map(id => result.files[id]?.path).filter(Boolean);
          // 如果扫描结果中没有路径，使用 selectedPath
          const updatedRootPaths = resultRootPaths.length > 0 ? resultRootPaths : [selectedPath];

          const dataToSave = {
              rootPaths: updatedRootPaths,
              customTags: state.customTags,
              people: state.people,
              settings: newSettings,
              fileMetadata: {}
          };
          
          const saveResult = await saveUserData(dataToSave);

          if (!saveResult) {
              console.error('[HANDLE_CHANGE_PATH] saveUserData returned false!');
          }
          
          showToast(t('settings.success'));
      } catch (e) {
          console.error("Change path failed", e);
          showToast("Error changing path");
      }
  };
  
  // Navigation helpers
  const pushHistory = useCallback((folderId: string, viewingId: string | null, viewMode: 'browser' | 'tags-overview' | 'people-overview' | 'topics-overview' = 'browser', searchQuery: string = '', searchScope: SearchScope = 'all', activeTags: string[] = [], activePersonId: string | null = null, nextScrollTop: number = 0, aiFilter: AiSearchFilter | null | undefined = null, activeTopicId: string | null = null) => { 
      const currentScrollTop = selectionRef.current?.scrollTop ?? activeTab.scrollTop;
      updateActiveTab(prevTab => { 
          const stackCopy = [...prevTab.history.stack];
          if (prevTab.history.currentIndex >= 0 && prevTab.history.currentIndex < stackCopy.length) {
              stackCopy[prevTab.history.currentIndex] = { ...stackCopy[prevTab.history.currentIndex], scrollTop: currentScrollTop };
          }
          const newStack = [...stackCopy.slice(0, prevTab.history.currentIndex + 1), { folderId, viewingId, viewMode, searchQuery, searchScope, activeTags, activePersonId, aiFilter, scrollTop: nextScrollTop, activeTopicId }]; 
          return { folderId, viewingFileId: viewingId, viewMode, searchQuery, searchScope, activeTags, activePersonId, aiFilter, scrollTop: nextScrollTop, activeTopicId, selectedFileIds: viewingId ? [viewingId] : [], selectedPersonIds: [], selectedTagIds: [], history: { stack: newStack, currentIndex: newStack.length - 1 } }; 
      }); 
  }, [activeTab.scrollTop]);


  
  const handleRememberFolderSettings = () => {
      if (activeTab.viewMode !== 'browser') return;
      const folderId = activeTab.folderId;
      const folder = state.files[folderId];
      if (!folder || folder.type !== FileType.FOLDER) return;
      
      const settings = {
          layoutMode: activeTab.layoutMode,
          sortBy: state.sortBy,
          sortDirection: state.sortDirection,
          groupBy: groupBy
      };
      
      const isCurrentlySaved = !!state.folderSettings[folderId];
      
      setState(prev => {
          const newFolderSettings = { ...prev.folderSettings };
          if (isCurrentlySaved) {
              // 如果已存在，删除（切换关闭）
              delete newFolderSettings[folderId];
          } else {
              // 如果不存在，添加（切换开启）
              newFolderSettings[folderId] = settings;
          }
          return { ...prev, folderSettings: newFolderSettings };
      });
      
      showToast(isCurrentlySaved ? t('folderSettings.remember') : t('folderSettings.saved'));
  };
  
  // 监听文件夹变化，自动应用保存的设置
  // 使用 ref 来避免将 folderSettings 加入依赖导致死循环
  const folderSettingsRef = useRef(state.folderSettings);
  useEffect(() => {
      folderSettingsRef.current = state.folderSettings;
  }, [state.folderSettings]);

  useEffect(() => {
      if (activeTab.viewMode !== 'browser') return;
      const folderId = activeTab.folderId;
      const savedSettings = folderSettingsRef.current[folderId];
      
      if (savedSettings) {
          // 检查是否需要更新，避免无限循环
          let hasChanges = false;
          if (activeTab.layoutMode !== savedSettings.layoutMode) hasChanges = true;
          if (state.sortBy !== savedSettings.sortBy) hasChanges = true;
          if (state.sortDirection !== savedSettings.sortDirection) hasChanges = true;
          if (groupBy !== savedSettings.groupBy) hasChanges = true;
          
          if (hasChanges) {
              setState(prev => ({
                  ...prev,
                  sortBy: savedSettings.sortBy,
                  sortDirection: savedSettings.sortDirection,
              }));
              setGroupBy(savedSettings.groupBy);
              updateActiveTab({ layoutMode: savedSettings.layoutMode });
          }
      }
  }, [activeTab.folderId, activeTab.id, activeTab.viewMode]);

  // 监听设置变化，同步更新已保存的文件夹设置
  useEffect(() => {
      if (activeTab.viewMode !== 'browser') return;
      const folderId = activeTab.folderId;
      const saved = state.folderSettings[folderId];
      
      if (saved) {
          const currentSettings = {
              layoutMode: activeTab.layoutMode,
              sortBy: state.sortBy,
              sortDirection: state.sortDirection,
              groupBy: groupBy
          };

          if (
              saved.layoutMode !== currentSettings.layoutMode ||
              saved.sortBy !== currentSettings.sortBy ||
              saved.sortDirection !== currentSettings.sortDirection ||
              saved.groupBy !== currentSettings.groupBy
          ) {
              setState(prev => ({
                  ...prev,
                  folderSettings: {
                      ...prev.folderSettings,
                      [folderId]: currentSettings
                  }
              }));
          }
      }
  }, [activeTab.layoutMode, state.sortBy, state.sortDirection, groupBy, activeTab.folderId, activeTab.viewMode, state.folderSettings]);

  const enterFolder = (folderId: string) => {
      pushHistory(folderId, null, 'browser', '', 'all', [], null, 0);
  };
  const handleNavigateFolder = (id: string) => { closeContextMenu(); enterFolder(id); };

  const handleNavigateTopic = useCallback((topicId: string | null) => {
      pushHistory(activeTab.folderId, null, 'topics-overview', '', 'all', [], null, 0, null, topicId);
  }, [activeTab.folderId, pushHistory]);

  const handleNavigateTopics = useCallback(() => {
    handleNavigateTopic(null);
  }, [handleNavigateTopic]);
  
  const handleCreateTopic = useCallback((parentId: string | null, name?: string) => {
      const id = Math.random().toString(36).substr(2, 9);
      const newTopic: Topic = {
          id,
          parentId,
          name: name || t('context.newTopicDefault') || 'New Topic',
          peopleIds: [],
          fileIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
      };
      setState(prev => ({ ...prev, topics: { ...prev.topics, [id]: newTopic } }));
  }, [t]);

  const handleUpdateTopic = useCallback((topicId: string, updates: Partial<Topic>) => {
      setState(prev => ({
          ...prev,
          topics: {
              ...prev.topics,
              [topicId]: { ...prev.topics[topicId], ...updates, updatedAt: new Date().toISOString() }
          }
      }));
  }, []);

  const handleDeleteTopic = useCallback((topicId: string) => {
      setState(prev => {
          const newTopics = { ...prev.topics };
          delete newTopics[topicId];
          return { ...prev, topics: newTopics };
      });
  }, []);

  const handleToggleFolder = (id: string) => {
    setState(prev => {
      const isCurrentlyExpanded = prev.expandedFolderIds.includes(id);
      const newExpandedIds = isCurrentlyExpanded
        ? prev.expandedFolderIds.filter(fid => fid !== id)
        : [...prev.expandedFolderIds, id];
      
      // 检查数组是否真的发生了变化 - 比较长度和内容
      if (newExpandedIds.length === prev.expandedFolderIds.length &&
          newExpandedIds.every(id => prev.expandedFolderIds.includes(id))) {
        return prev;
      }
      
      return {
        ...prev,
        expandedFolderIds: newExpandedIds
      };
    });
  };
  const goBack = () => { 
      updateActiveTab(prevTab => { 
          if (prevTab.history.currentIndex > 0) { 
              const newIndex = prevTab.history.currentIndex - 1; 
              const step = prevTab.history.stack[newIndex]; 
              return { folderId: step.folderId, viewingFileId: step.viewingId, viewMode: step.viewMode, searchQuery: step.searchQuery, searchScope: step.searchScope, activeTags: step.activeTags || [], activePersonId: step.activePersonId, activeTopicId: step.activeTopicId || null, aiFilter: step.aiFilter, scrollTop: step.scrollTop || 0, selectedFileIds: step.viewingId ? [step.viewingId] : [], selectedPersonIds: [], selectedTagIds: [], history: { ...prevTab.history, currentIndex: newIndex } }; 
          } 
          return {}; 
      }); 
  };
  const goForward = () => { 
      updateActiveTab(prevTab => { 
          if (prevTab.history.currentIndex < prevTab.history.stack.length - 1) { 
              const newIndex = prevTab.history.currentIndex + 1; 
              const step = prevTab.history.stack[newIndex]; 
              return { folderId: step.folderId, viewingFileId: step.viewingId, viewMode: step.viewMode, searchQuery: step.searchQuery, searchScope: step.searchScope, activeTags: step.activeTags || [], activePersonId: step.activePersonId, activeTopicId: step.activeTopicId || null, aiFilter: step.aiFilter, scrollTop: step.scrollTop || 0, selectedFileIds: step.viewingId ? [step.viewingId] : [], selectedPersonIds: [], selectedTagIds: [], history: { ...prevTab.history, currentIndex: newIndex } }; 
          } 
          return {}; 
      }); 
  };
  
  const closeViewer = () => { 
      if (activeTab.history.stack[activeTab.history.currentIndex].viewingId) { 
          pushHistory(activeTab.folderId, null, activeTab.viewMode as any, activeTab.searchQuery, activeTab.searchScope, activeTab.activeTags, activeTab.activePersonId, activeTab.scrollTop, activeTab.aiFilter, activeTab.activeTopicId); 
      } else { 
          updateActiveTab({ viewingFileId: null }); 
      } 
  };
  
  const enterViewer = (fileId: string) => {
      const scrollTop = selectionRef.current?.scrollTop || 0;
      pushHistory(activeTab.folderId, fileId, 'browser', activeTab.searchQuery, activeTab.searchScope, activeTab.activeTags, activeTab.activePersonId, scrollTop, activeTab.aiFilter, activeTab.activeTopicId);
  };

  const handleViewerNavigate = (direction: 'next' | 'prev' | 'random') => {
      if (!activeTab.viewingFileId) return;
      
      // Filter to get only image file IDs
      const imageFileIds = displayFileIds.filter(id => state.files[id].type === FileType.IMAGE);
      if (imageFileIds.length === 0) return;
      
      const currentFile = state.files[activeTab.viewingFileId];
      let currentIndex = imageFileIds.indexOf(activeTab.viewingFileId);
      
      // If current file is not in image list (shouldn't happen), start from beginning
      if (currentIndex === -1) {
          currentIndex = 0;
      }
      
      let nextIndex = currentIndex;
      if (direction === 'random') {
          nextIndex = Math.floor(Math.random() * imageFileIds.length);
      } else if (direction === 'next') {
          nextIndex = (currentIndex + 1) % imageFileIds.length;
      } else {
          nextIndex = (currentIndex - 1 + imageFileIds.length) % imageFileIds.length;
      }
      
      const nextId = imageFileIds[nextIndex];
      updateActiveTab(prev => {
          const newStack = [...prev.history.stack];
          if (prev.history.currentIndex >= 0 && prev.history.currentIndex < newStack.length) {
              newStack[prev.history.currentIndex] = { ...newStack[prev.history.currentIndex], viewingId: nextId };
          }
          return { viewingFileId: nextId, selectedFileIds: [nextId], lastSelectedId: nextId, history: { ...prev.history, stack: newStack } };
      });
  };
  const handleViewerJump = (fileId: string) => {
      updateActiveTab(prev => {
          const newStack = [...prev.history.stack];
          if (prev.history.currentIndex >= 0 && prev.history.currentIndex < newStack.length) {
              newStack[prev.history.currentIndex] = { ...newStack[prev.history.currentIndex], viewingId: fileId };
          }
          return { viewingFileId: fileId, selectedFileIds: [fileId], lastSelectedId: fileId, history: { ...prev.history, stack: newStack } };
      });
  };
  
  const performAiSearch = async (query: string) => {
      if (!query.trim()) {
          pushHistory(activeTab.folderId, null, 'browser', '', activeTab.searchScope, activeTab.activeTags, null, 0, null);
          return;
      }

      const taskId = startTask('ai', [], t('settings.aiSmartSearchThinking'), false);
      showToast(t('settings.aiSmartSearchThinking'));

      try {
          const aiConfig = state.settings.ai;
          const prompt = `
          Analyze this search query for a photo gallery: "${query}".
          Extract search intent and criteria into a JSON object.
          Return ONLY JSON.
          
          Expected JSON Structure:
          {
            "keywords": string[], // Synonyms, objects, tags
            "colors": string[], // Hex codes or color names
            "people": string[], // Names of people
            "description": string // A concise description of what to look for (optional)
          }
          `;

          let result: any = null;
          
          // Same logic as handleAIAnalysis but for search
          if (aiConfig.provider === 'openai') {
              const body = {
                  model: aiConfig.openai.model,
                  messages: [{ role: "user", content: prompt }],
                  max_tokens: 500
              };
              try {
                  const res = await fetch(`${aiConfig.openai.endpoint}/chat/completions`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiConfig.openai.apiKey}` },
                      body: JSON.stringify(body)
                  });
                  const resData = await res.json();
                  if (resData?.choices?.[0]?.message?.content) { 
                      try { result = JSON.parse(resData.choices[0].message.content); } catch(e){} 
                  }
              } catch (e) {
                  console.error('AI search failed:', e);
              }
          } else if (aiConfig.provider === 'ollama') {
              const body = { model: aiConfig.ollama.model, prompt: prompt, stream: false, format: "json" };
              try {
                  const res = await fetch(`${aiConfig.ollama.endpoint}/api/generate`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(body)
                  });
                  const resData = await res.json();
                  if (resData?.response) {
                      try { result = JSON.parse(resData.response); } catch(e){}
                  }
              } catch (e) {
                  console.error('AI search failed:', e);
              }
          } else if (aiConfig.provider === 'lmstudio') {
              const body = { model: aiConfig.lmstudio.model, messages: [{ role: "user", content: prompt }], max_tokens: 500, stream: false };
              let endpoint = aiConfig.lmstudio.endpoint.replace(/\/+$/, '');
              if (!endpoint.endsWith('/v1')) endpoint += '/v1';
              try {
                  const res = await fetch(`${endpoint}/chat/completions`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(body)
                  });
                  const resData = await res.json();
                  if (resData?.choices?.[0]?.message?.content) {
                      try { result = JSON.parse(resData.choices[0].message.content); } catch(e){}
                  }
              } catch (e) {
                  console.error('AI search failed:', e);
              }
          }

          if (result) {
              const aiFilter = {
                  originalQuery: query,
                  keywords: result.keywords || [],
                  colors: result.colors || [],
                  people: result.people || [],
                  description: result.description
              };
              
              // Apply the AI filter to the search
              pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0, aiFilter);
              showToast("AI Search Applied");
          } else {
              // Fallback to normal search if AI fails
              pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0, null);
              showToast("AI Search Failed, using standard search");
          }

      } catch (e) {
          console.error("AI Search Error", e);
          pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0, null);
          showToast("AI Search Error");
      } finally {
          updateTask(taskId, { current: 1, status: 'completed' });
          setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 500);
      }
  };

// 替换 App.tsx 中的 onPerformSearch
  const onPerformSearch = async (query: string) => {

      // 1. 颜色搜索逻辑
      if (query.startsWith('color:')) {
          let hex = query.replace('color:', '').trim();
          if (hex.startsWith('#')) hex = hex.substring(1);

          const taskId = startTask('ai', [], t('status.searching'), false);
          
          try {
              const results = await searchByColor(`#${hex}`);
              
              if (results.length > 0) {
              } else {
              }

              // 【核心修复 & 调试】：超级路径标准化
              const allFiles = Object.values(state.files);
              
              // 打印一个前端现有的路径看看长什么样
              if (allFiles.length > 0) {
                 // 找一个带路径的文件打印出来对比
                 const sample = allFiles.find(f => f.path); 
                 if (sample) console.log("💻 前端现有路径示例:", sample.path);
              }

              const validPaths: string[] = [];
              
              // 优化的匹配逻辑：移除 \\?\ 前缀，统一斜杠，统一小写
              const normalize = (p: string) => {
                  if (!p) return '';
                  // 1. 移除 Windows 长路径前缀 \\?\
                  let clean = p.startsWith('\\\\?\\') ? p.slice(4) : p;
                  // 2. 反斜杠转正斜杠
                  clean = clean.replace(/\\/g, '/');
                  // 3. 转小写
                  return clean.toLowerCase();
              };

              results.forEach(rustPath => {
                  const normRust = normalize(rustPath);
                  
                  // 在所有文件中查找
                  const match = allFiles.find(f => {
                      if (!f.path) return false;
                      const normFront = normalize(f.path);
                      // 这里的 debug 只在找不到时偶尔打印一下，防止刷屏
                      // if (normRust.includes('g93') && normFront.includes('g93')) {
                      //    console.log(`对比: \nRust: ${normRust} \nFront: ${normFront}`);
                      // }
                      return normFront === normRust;
                  });
                  
                  if (match && match.path) {
                      validPaths.push(match.path);
                  }
              });


              if (validPaths.length === 0 && results.length > 0) {
                  showToast(`后端找到 ${results.length} 张，但前端无法显示 (路径不匹配)`);
              }

              const aiFilter: AiSearchFilter = {
                  keywords: [],
                  colors: [hex],
                  people: [],
                  originalQuery: query,
                  filePaths: validPaths
              };
              
              // 强制跳转逻辑 - 颜色搜索不再在搜索框保留文本，仅保留在 aiFilter 中
              pushHistory(activeTab.folderId, null, 'browser', '', activeTab.searchScope, activeTab.activeTags, null, 0, aiFilter);

          } catch (e) {
              console.error("Color search failed", e);
              showToast("Color search failed");
          } finally {
              updateTask(taskId, { current: 1, status: 'completed' });
              setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 500);
          }
          return;
      }

      // 2. 原有的普通搜索逻辑
      if (state.settings.search.isAISearchEnabled) {
          await performAiSearch(query);
      } else {
          pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0);
      }
  };

  const handlePerformSearch = onPerformSearch;

  const handleViewerSearch = (query: string) => pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0);
  const enterTagView = (tagName: string) => pushHistory(activeTab.folderId, null, 'browser', '', 'tag', [tagName], null, 0);
  const enterTagsOverview = () => pushHistory(activeTab.folderId, null, 'tags-overview', activeTab.searchQuery, activeTab.searchScope, activeTab.activeTags, null, 0);
  const enterPeopleOverview = () => pushHistory(activeTab.folderId, null, 'people-overview', activeTab.searchQuery, activeTab.searchScope, activeTab.activeTags, null, 0);
  const enterPersonView = (personId: string) => pushHistory(activeTab.folderId, null, 'browser', '', 'all', [], personId, 0);
  const handleClearTagFilter = (tagToRemove: string) => updateActiveTab(prev => ({ activeTags: prev.activeTags.filter(t => t !== tagToRemove) }));
  const handleClearAllTags = () => updateActiveTab({ activeTags: [] });
  const handleClearPersonFilter = () => updateActiveTab({ activePersonId: null });
  
  const handleRenameSubmit = async (value: string, id: string) => {
      value = value.trim();
      const file = state.files[id];
      if (!value || value === file.name) { setState(s => ({ ...s, renamingId: null })); return; }
      if (file.path) {
          try {
              const separator = file.path.includes('/') ? '/' : '\\';
              const parentPath = file.path.substring(0, file.path.lastIndexOf(separator));
              const newPath = `${parentPath}${separator}${value}`;
              
              // Use appropriate renameFile function based on environment
              const isTauriEnv = isTauriEnvironment();
              if (isTauriEnv) {
                  await renameFile(file.path, newPath);
              } else {
                  throw new Error("No file system access available");
              }
              
              await handleRefresh();
              setState(s => ({ ...s, renamingId: null }));
          } catch (e) {
              console.error("Rename failed", e);
              showToast("Rename failed");
          }
      } else {
          handleUpdateFile(id, { name: value });
          setState(s => ({ ...s, renamingId: null }));
      }
  };

  const requestDelete = (ids: string[]) => {
    const filesToDelete = ids.map(id => state.files[id]).filter(Boolean);
    if (filesToDelete.length === 0) return;
    const taskId = Math.random().toString(36).substr(2, 9);
    const newTask: DeletionTask = { id: taskId, files: filesToDelete };
    setState(prev => {
        const newFiles = { ...prev.files };
        ids.forEach(id => {
             const file = newFiles[id];
             if (file && file.parentId && newFiles[file.parentId]) {
                 const parent = newFiles[file.parentId];
                 newFiles[file.parentId] = { ...parent, children: parent.children?.filter(cid => cid !== id) };
             }
             delete newFiles[id];
        });
        
        const updatedTabs = prev.tabs.map(t => {
            // 如果当前标签页正在查看被删除的文件，清除 viewingFileId
            const isViewingDeletedFile = t.viewingFileId && ids.includes(t.viewingFileId);
            return {
                ...t,
                selectedFileIds: t.selectedFileIds.filter(fid => !ids.includes(fid)),
                viewingFileId: isViewingDeletedFile ? null : t.viewingFileId
            };
        });
        
        return { ...prev, files: newFiles, tabs: updatedTabs };
    });
    setDeletionTasks(prev => [...prev, newTask]);
  };

  const undoDelete = (taskId: string) => {
      const task = deletionTasks.find(t => t.id === taskId);
      if (!task) return;
      setState(prev => {
          const newFiles = { ...prev.files };
          task.files.forEach(file => {
              newFiles[file.id] = file;
              if (file.parentId && newFiles[file.parentId]) {
                  const parent = newFiles[file.parentId];
                  if (!parent.children?.includes(file.id)) {
                      newFiles[file.parentId] = { ...parent, children: [...(parent.children || []), file.id] };
                  }
              }
          });
          return { ...prev, files: newFiles };
      });
      setDeletionTasks(prev => prev.filter(t => t.id !== taskId));
  };

  const dismissDelete = async (taskId: string) => {
      const task = deletionTasks.find(t => t.id === taskId);
      if (task) {
          for (const file of task.files) {
              if (file.path) {
                  // Use appropriate deleteFile function based on environment
                  const isTauriEnv = isTauriEnvironment();
                  if (isTauriEnv) {
                      await deleteFile(file.path);
                  } else {
                      throw new Error("No file system access available");
                  }
              }
          }
      }
      setDeletionTasks(prev => prev.filter(t => t.id !== taskId));
  };

  const handleContextMenu = (e: React.MouseEvent, type: 'file' | 'tag' | 'tag-background' | 'root-folder' | 'background' | 'tab' | 'person', id: string) => { 
    e.preventDefault(); e.stopPropagation(); 
    let menuType: any = null; 
    if (type === 'file') { 
      if (!activeTab.selectedFileIds.includes(id)) { 
        updateActiveTab({ selectedFileIds: [id], lastSelectedId: id }); 
        menuType = state.files[id].type === FileType.FOLDER ? 'folder-single' : 'file-single'; 
      } else { 
        if (activeTab.selectedFileIds.length > 1) { 
          // 检查所有选中的项目类型
          const selectedItems = activeTab.selectedFileIds.map(fileId => state.files[fileId]);
          const allAreFolders = selectedItems.every(item => item && item.type === FileType.FOLDER);
          const allAreFiles = selectedItems.every(item => item && item.type !== FileType.FOLDER);
          
          if (allAreFolders) {
            menuType = 'folder-multi';
          } else if (allAreFiles) {
            menuType = 'file-multi';
          } else {
            // 混合类型，使用 file-multi 作为默认值
            menuType = 'file-multi';
          }
        } else { 
          menuType = state.files[id].type === FileType.FOLDER ? 'folder-single' : 'file-single'; 
        } 
      } 
    } 
    else if (type === 'tag') { if (!activeTab.selectedTagIds.includes(id)) { updateActiveTab({ selectedTagIds: [id] }); menuType = 'tag-single'; } else { menuType = activeTab.selectedTagIds.length > 1 ? 'tag-multi' : 'tag-single'; } } 
    else if (type === 'tag-background') { menuType = 'tag-background'; } 
    else if (type === 'root-folder') { menuType = 'root-folder'; } 
    else if (type === 'tab') { menuType = 'tab'; } 
    else if (type === 'person') { menuType = 'person'; } 
    else { if (activeTab.viewMode === 'tags-overview') { menuType = 'tag-background'; } else { menuType = 'background'; } } 
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, type: menuType, targetId: id }); 
  };
  const closeContextMenu = () => setContextMenu({ ...contextMenu, visible: false });
  const handleNavigateUp = () => { 
      if (activeTab.activeTopicId) {
          const currentTopic = state.topics[activeTab.activeTopicId];
          handleNavigateTopic(currentTopic?.parentId || null);
      } else if (activeTab.activePersonId) { 
          enterPeopleOverview(); 
      } else if (activeTab.viewMode === 'people-overview' || activeTab.viewMode === 'tags-overview' || activeTab.viewMode === 'topics-overview') { 
          enterFolder(activeTab.folderId); 
      } else { 
          const current = state.files[activeTab.folderId]; 
          if (current && current.parentId) { 
              enterFolder(current.parentId); 
          } 
      } 
  };
  const minimizeTask = (id: string) => { setState(prev => ({ ...prev, tasks: prev.tasks.map(t => t.id === id ? { ...t, minimized: true } : t) })); };
  const onRestoreTask = (id: string) => { setState(prev => ({ ...prev, tasks: prev.tasks.map(t => t.id === id ? { ...t, minimized: false } : t) })); };

  const onPauseResume = async (id: string, taskType: string) => {
    if (taskType !== 'color') return;
    
    const task = state.tasks.find(t => t.id === id);
    if (!task) return;
    
    if (task.status === 'paused') {
      await resumeColorExtraction();
      const now = Date.now();
      updateTask(id, { 
        status: 'running',
        estimatedTime: undefined,
        lastProgressUpdate: now,
        lastProgress: task.current,
        lastEstimatedTimeUpdate: now
      });
    } else {
      await pauseColorExtraction();
      updateTask(id, { status: 'paused' });
    }
  };
  
  const handleCreateFolder = async (targetId?: string) => {
      const parentId = targetId || activeTab.folderId;
      // Check if we're in the root directory (no parent folder)
      if (!parentId) {
          // Create folder in root directory
          const baseName = t('context.newFolder');
          let name = baseName;
          let counter = 1;
          
          // Find all root files to check for name conflicts
          const rootFiles = state.roots.map(rootId => state.files[rootId]);
          while (rootFiles.some(file => file?.name === name)) {
              name = `${baseName} (${counter++})`;
          }
          
          // Create new folder in root
          const newId = Math.random().toString(36).substr(2, 9);
          const newFolder: FileNode = {
              id: newId,
              parentId: null,
              name,
              type: FileType.FOLDER,
              path: '',
              children: [],
              tags: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
          };
          
          setState(prev => ({
              ...prev,
              files: { ...prev.files, [newId]: newFolder },
              roots: [...prev.roots, newId],
              renamingId: newId
          }));
          return;
      }
      
      const parent = state.files[parentId];
      if (!parent) return;
      const baseName = t('context.newFolder');
      let name = baseName;
      if (parent.path) {
          try {
              let counter = 1;
              const children = parent.children?.map(id => state.files[id]) || [];
              while (children.some(c => c.name === name)) { name = `${baseName} (${counter++})`; }
              const separator = parent.path.includes('/') ? '/' : '\\';
              const newPath = `${parent.path}${separator}${name}`;
              
              // Use appropriate createFolder function based on environment
              const isTauriEnv = isTauriEnvironment();
              if (isTauriEnv) {
                  await createFolder(newPath);
              } else {
                  throw new Error("No file system access available");
              }
              
              await handleRefresh();
              
              // Find the newly created folder and set it to renaming state
              setState(prev => {
                  const parentFolder = prev.files[parentId];
                  if (parentFolder?.children) {
                      // Get all children files
                      const childFiles = parentFolder.children.map(id => prev.files[id]);
                      // Find the folder with the matching name we just created
                      const newFolder = childFiles.find(file => file?.name === name && file?.type === FileType.FOLDER);
                      if (newFolder) {
                          return { ...prev, renamingId: newFolder.id };
                      }
                  }
                  return prev;
              });
          } catch (error) { console.error(error); showToast("Error creating folder"); }
      } else {
          let counter = 1;
          const children = parent.children?.map(id => state.files[id]) || [];
          while (children.some(c => c.name === name)) { name = `${baseName} (${counter++})`; }
          const newId = Math.random().toString(36).substr(2, 9);
          const newFolder: FileNode = {
              id: newId,
              parentId: parentId,
              name,
              type: FileType.FOLDER,
              path: '',
              children: [],
              tags: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
          };
          setState(prev => {
              const newFiles = { ...prev.files, [newId]: newFolder };
              if (newFiles[parentId]) {
                  newFiles[parentId] = { ...newFiles[parentId], children: [...(newFiles[parentId].children || []), newId] };
              }
              return { ...prev, files: newFiles, renamingId: newId };
          });
      }
  };

  const handleOpenInNewTab = (fileId: string) => {
      const file = state.files[fileId];
      if (!file) return;
      const isFolder = file.type === FileType.FOLDER;
      const targetFolderId = isFolder ? fileId : (file.parentId || fileId);
      const targetViewingId = isFolder ? null : fileId;
      const newTab: TabState = {
          id: Math.random().toString(36).substr(2, 9),
          folderId: targetFolderId,
          viewingFileId: targetViewingId,
          viewMode: 'browser',
          layoutMode: 'grid',
          searchQuery: '',
          searchScope: 'all',
          activeTags: [],
          activePersonId: null,
          activeTopicId: null,
          selectedTopicIds: [],
          selectedFileIds: [fileId],
          lastSelectedId: fileId,
          selectedTagIds: [],
          selectedPersonIds: [],
          dateFilter: { start: null, end: null, mode: 'created' },
          history: { stack: [], currentIndex: 0 },
          scrollTop: 0
      };
      newTab.history.stack = [{ folderId: newTab.folderId, viewingId: newTab.viewingFileId, viewMode: 'browser', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }];
      setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
  };

  const handleGenerateThumbnails = async (folderIds: string[]) => {
      const getAllImageFilesInFolder = (folderId: string): string[] => {
          const folder = state.files[folderId];
          if (!folder) return [];
          
          let fileIds: string[] = [];
          
          // Use stack for DFS to avoid recursion depth issues
          const stack = [folderId];
          const visited = new Set<string>();

          while (stack.length > 0) {
              const currentId = stack.pop()!;
              if (visited.has(currentId)) continue;
              visited.add(currentId);

              const currentFolder = state.files[currentId];
              if (currentFolder && currentFolder.children) {
                  for (const childId of currentFolder.children) {
                      const child = state.files[childId];
                      if (child) {
                          if (child.type === FileType.FOLDER) {
                              stack.push(childId);
                          } else if (child.type === FileType.IMAGE) {
                              fileIds.push(childId);
                          }
                      }
                  }
              }
          }
          return fileIds;
      };

      // Collect all image IDs from selected folders
      let allImageIds: string[] = [];
      for (const fid of folderIds) {
          allImageIds = [...allImageIds, ...getAllImageFilesInFolder(fid)];
      }
      
      // Deduplicate
      allImageIds = Array.from(new Set(allImageIds));

      if (allImageIds.length === 0) {
          showToast(t('tasks.noImagesFound'));
          return;
      }

      const taskId = startTask('thumbnail', [], t('tasks.generatingThumbnails'), false);
      updateTask(taskId, { total: allImageIds.length, current: 0 });

      // Use a simple concurrency control
      let completed = 0;
      const MAX_CONCURRENT = 20;
      const queue = [...allImageIds];
      const activePromises: Promise<void>[] = [];

      const processNext = async () => {
          if (queue.length === 0) return;
          const id = queue.pop()!;
          const file = state.files[id];
          
          if (file) {
              try {
                  // getThumbnail handles batching internally, but we await it to track progress
                  await getThumbnail(file.path, file.updatedAt, state.settings.paths.resourceRoot);
              } catch (e) {
                  console.error('Thumbnail gen error', e);
              }
          }
          
          completed++;
          updateTask(taskId, { current: completed });
          
          // Continue processing if queue not empty
          if (queue.length > 0) {
              await processNext();
          }
      };

      // Start initial batch
      for (let i = 0; i < Math.min(MAX_CONCURRENT, allImageIds.length); i++) {
          activePromises.push(processNext());
      }

      await Promise.all(activePromises);
      
      setTimeout(() => {
          setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) }));
          showToast(t('tasks.thumbnailsGenerated'));
      }, 1000);
  };

  const handleViewInExplorer = async (id: string) => {
    const file = state.files[id];
    if (!file?.path) {
      console.error('handleViewInExplorer: file or path not found', { id, file });
      return;
    }
    
    // 确保路径是绝对路径
    const targetPath = file.path;
    console.log('handleViewInExplorer:', { id, path: targetPath, type: file.type, name: file.name });
    
    try {
      if (isTauriEnvironment()) {
        // Tauri 环境：使用 openPath API
        const { openPath } = await import('./api/tauri-bridge');
        // 传入 isFile 参数：非文件夹都是文件，需要选中；文件夹直接打开
        const isFile = file.type !== FileType.FOLDER;
        console.log('Calling openPath:', { path: targetPath, isFile });
        await openPath(targetPath, isFile);
      }
    } catch (error) {
      console.error('Failed to open in explorer:', error);
    }
  };
  const handleSwitchTab = (id: string) => setState(s => ({ ...s, activeTabId: id }));
  const handleCloseTab = (e: React.MouseEvent, id: string) => { e.stopPropagation(); setState(prev => { const newTabs = prev.tabs.filter(t => t.id !== id); if (newTabs.length === 0) return prev; let newActiveId = prev.activeTabId; if (id === prev.activeTabId) { const index = prev.tabs.findIndex(t => t.id === id); newActiveId = newTabs[Math.max(0, index - 1)].id; } return { ...prev, tabs: newTabs, activeTabId: newActiveId }; }); };
  const handleNewTab = () => { const newTab: TabState = { ...DUMMY_TAB, id: Math.random().toString(36).substr(2, 9), folderId: state.roots[0] || '' }; newTab.history = { stack: [{ folderId: newTab.folderId, viewingId: null, viewMode: 'browser', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 }; setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id })); };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Tab: Switch to next tab
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const currentIndex = state.tabs.findIndex(tab => tab.id === state.activeTabId);
        const nextIndex = (currentIndex + 1) % state.tabs.length;
        const nextTabId = state.tabs[nextIndex].id;
        handleSwitchTab(nextTabId);
      }
      // Ctrl+W: Close current tab
      else if (e.ctrlKey && e.key === 'w') {
        e.preventDefault();
        if (state.tabs.length > 1) {
          handleCloseTab(e as any, state.activeTabId);
        }
      }
      // Ctrl+T: New tab
      else if (e.ctrlKey && e.key === 't') {
        e.preventDefault();
        handleNewTab();
      }
      // Ctrl+R: Refresh
      else if (e.ctrlKey && e.key === 'r') {
        e.preventDefault();
        handleRefresh();
      }
      // Delete: Delete selected files/folders
      else if (e.key === 'Delete') {
        if (activeTab.selectedFileIds.length > 0) {
          e.preventDefault();
          requestDelete(activeTab.selectedFileIds);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state.tabs, state.activeTabId, handleSwitchTab, handleCloseTab, handleNewTab, handleRefresh, activeTab.selectedFileIds, requestDelete]);

  // Context menu close handlers
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (contextMenu.visible) {
        // 获取菜单元素
        const menuElement = document.querySelector('.fixed.bg-white[data-testid="context-menu"]');
        // 使用data-testid选择器代替复杂的CSS类选择器，避免语法错误
        // 检查点击是否在菜单内部
        if (!menuElement || !menuElement.contains(e.target as Node)) {
          closeContextMenu();
        }
      }
    };

    const handleWheel = () => {
      if (contextMenu.visible) {
        closeContextMenu();
      }
    };

    // 使用冒泡阶段，确保菜单内部点击能正常处理
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('wheel', handleWheel, true);

    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('wheel', handleWheel, true);
    };
  }, [contextMenu.visible, closeContextMenu]);
  const handleCloseAllTabs = () => { /* ... */ };
  const handleCloseOtherTabs = (id: string) => { /* ... */ };
  
  // 递归获取所有子文件夹ID
  const getAllSubFolderIds = (folderId: string): string[] => {
    const folder = state.files[folderId];
    if (!folder || folder.type !== FileType.FOLDER || !folder.children) {
      return [];
    }
    
    let allIds: string[] = [];
    for (const childId of folder.children) {
      const child = state.files[childId];
      if (child && child.type === FileType.FOLDER) {
        allIds.push(childId);
        allIds = [...allIds, ...getAllSubFolderIds(childId)];
      }
    }
    return allIds;
  };
  
  const handleExpandAll = (id: string) => {
    const allSubFolderIds = getAllSubFolderIds(id);
    setState(prev => ({
      ...prev,
      expandedFolderIds: [...new Set([...prev.expandedFolderIds, ...allSubFolderIds])]
    }));
  };
  
  const handleCollapseAll = (id: string) => {
    const allSubFolderIds = getAllSubFolderIds(id);
    setState(prev => ({
      ...prev,
      expandedFolderIds: prev.expandedFolderIds.filter(folderId => 
        !allSubFolderIds.includes(folderId)
      )
    }));
  };

  const handleAIAnalysis = async (fileIds: string | string[], folderId?: string) => {
      // Convert single fileId to array
      const idsToProcess = typeof fileIds === 'string' ? [fileIds] : fileIds;
      
      // Filter out non-image files
      const imageFileIds = idsToProcess.filter(id => {
          const file = state.files[id];
          return file && file.type === FileType.IMAGE;
      });
      
      const aiConfig = state.settings.ai;
      const targetLanguage = state.settings.language === 'zh' ? 'Simplified Chinese' : 'English';
      
      // If no image files to analyze but folderId is provided, generate summary directly
      if (imageFileIds.length === 0 && folderId) {
          // Create a task for folder AI analysis
          const taskId = startTask('ai', [], t('tasks.aiAnalysis'), false);
          updateTask(taskId, { total: 5, current: 0 }); // 5 steps for folder analysis
          
          // Step 1: Get all image files in the folder
          const getAllImageFilesInFolder = (folderId: string): string[] => {
              const folder = state.files[folderId];
              if (!folder) return [];
              
              let fileIds: string[] = [];
              
              if (folder.children) {
                  for (const childId of folder.children) {
                      const child = state.files[childId];
                      if (child) {
                          if (child.type === FileType.FOLDER) {
                              // Recursively get files from subfolders
                              fileIds = [...fileIds, ...getAllImageFilesInFolder(childId)];
                          } else if (child.type === FileType.IMAGE) {
                              // Add image file to list
                              fileIds.push(childId);
                          }
                      }
                  }
              }
              
              return fileIds;
          };
          
          const allFolderImageIds = getAllImageFilesInFolder(folderId);
          if (allFolderImageIds.length === 0) {
              setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 1000);
              return;
          }
          
          // Step 2: Prepare all descriptions and extracted text from already analyzed images
          updateTask(taskId, { current: 2, currentStep: t('tasks.preparingData') });
          const allResults: { description: string; translatedText?: string; extractedText: string }[] = [];
          
          for (const fileId of allFolderImageIds) {
              const file = state.files[fileId];
              if (file && file.aiData?.analyzed) {
                  allResults.push({
                      description: file.aiData.description || '',
                      translatedText: file.aiData.translatedText,
                      extractedText: file.aiData.extractedText || ''
                  });
              }
          }
          
          if (allResults.length === 0) {
              setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 1000);
              return;
          }
          
          // Step 3: Generate summary directly
          updateTask(taskId, { current: 3, currentStep: t('tasks.generatingSummary') });
          const folder = state.files[folderId];
          if (folder) {
              // Prepare all descriptions, translated text, and extracted text for AI story generation
              const allDescriptions = allResults
                  .filter(r => r.description)
                  .map(r => r.description)
                  .filter(Boolean)
                  .join('\n\n');
              
              const allTranslatedText = allResults
                  .filter(r => r.translatedText)
                  .map(r => r.translatedText)
                  .filter(Boolean)
                  .join('\n\n');
              
              const allExtractedText = allResults
                  .filter(r => r.extractedText)
                  .map(r => r.extractedText)
                  .filter(Boolean)
                  .join('\n\n');
              
              if (allDescriptions || allTranslatedText || allExtractedText) {
                  let summary = '';
                  
                  // Create prompt for AI analysis generation
                  const analysisPrompt = `Based on the following image descriptions, translated text, and extracted text, provide a detailed analysis and summary of the content. Your output must be in ${targetLanguage}.\n\nPlease include the following elements:\n1. Overall story or narrative connecting the images\n2. Key characters and their actions\n3. Important plot points or events\n4. If there is any extracted text or dialogue, mention the key quotes and provide a brief analysis of their significance\n5. If there are translated texts, analyze their content and significance\n6. The overall theme or message conveyed by the images\n\nImage Descriptions:\n${allDescriptions || 'No descriptions available'}\n\nTranslated Text (if any):\n${allTranslatedText || 'No translated text available'}\n\nExtracted Text (if any):\n${allExtractedText || 'No text extracted from images'}\n\nComprehensive Analysis:`;
                  
                  try {
                      // Step 4: Call AI API for summary generation
                      updateTask(taskId, { current: 4, currentStep: t('tasks.aiAnalyzing') });
                      let result: any = null;
                      
                      if (aiConfig.provider === 'openai') {
                          const body = {
                              model: aiConfig.openai.model,
                              messages: [{ role: "user", content: analysisPrompt }],
                              max_tokens: 1500,
                              temperature: 0.7
                          };
                          try {
                              const res = await fetch(`${aiConfig.openai.endpoint}/chat/completions`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiConfig.openai.apiKey}` },
                                  body: JSON.stringify(body)
                              });
                              const resData = await res.json();
                              if (resData?.choices?.[0]?.message?.content) { 
                                  summary = resData.choices[0].message.content;
                              }
                          } catch (e) {
                              console.error('AI analysis failed:', e);
                          }
                      } else if (aiConfig.provider === 'ollama') {
                          const body = { 
                              model: aiConfig.ollama.model, 
                              prompt: analysisPrompt, 
                              stream: false,
                              temperature: 0.7
                          };
                          try {
                              const res = await fetch(`${aiConfig.ollama.endpoint}/api/generate`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify(body)
                              });
                              const resData = await res.json();
                              if (resData?.response) { 
                                  summary = resData.response;
                              }
                          } catch (e) {
                              console.error('AI analysis failed:', e);
                          }
                      } else if (aiConfig.provider === 'lmstudio') {
                          let endpoint = aiConfig.lmstudio.endpoint.replace(/\/+$/, '');
                          // LM Studio API may use different endpoints depending on the model
                          const body = {
                              model: aiConfig.lmstudio.model,
                              prompt: analysisPrompt,
                              max_tokens: 1500,
                              temperature: 0.7,
                              stream: false
                          };
                          
                          // Try multiple endpoints that LM Studio might support
                          const endpointsToTry = ['/chat/completions', '/v1/chat/completions', '/generate', '/v1/generate'];
                          let success = false;
                          
                          for (const apiEndpoint of endpointsToTry) {
                              try {
                                  const res = await fetch(`${endpoint}${apiEndpoint}`, {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify(apiEndpoint.includes('chat') ? {
                                          model: aiConfig.lmstudio.model,
                                          messages: [{ role: "user", content: analysisPrompt }],
                                          max_tokens: 1500,
                                          temperature: 0.7,
                                          stream: false
                                      } : body)
                                  });
                                  const resData = await res.json();
                                  
                                  if (resData && !resData.error) {
                                      if (resData.choices?.[0]?.message?.content) {
                                          summary = resData.choices[0].message.content;
                                          success = true;
                                          break;
                                      } else if (resData.response) {
                                          // Some LM Studio models might return response directly
                                          summary = resData.response;
                                          success = true;
                                          break;
                                      }
                                  }
                              } catch (error) {
                                  console.error(`LM Studio API Error with ${apiEndpoint}:`, error);
                              }
                          }
                          
                          if (!success) {
                              console.error('All LM Studio API endpoints failed');
                          }
                      }
                      
                      // If AI failed to generate analysis, create a concise summary instead of just listing
                      if (!summary) {
                          const isChinese = state.settings.language === 'zh';
                          
                          // Create a concise summary by combining all descriptions, translated text, and extracted text
                          const combinedContent = [
                              ...allResults.filter(r => r.description).map(r => r.description),
                              ...allResults.filter(r => r.translatedText).map(r => r.translatedText),
                              ...(allExtractedText ? [allExtractedText] : [])
                          ].join(' ');
                          
                          // Simple summarization approach: extract key points
                          const sentences = combinedContent.split(/[.!?。！？]+/).filter(s => s.trim().length > 10);
                          const keySentences = sentences.slice(0, 5); // Take first 5 meaningful sentences
                          
                          summary = isChinese ? `## 图片分析汇总\n\n` : `## Image Analysis Summary\n\n`;
                          summary += isChinese ? `基于对文件夹内图片的分析，以下是主要内容：\n\n` : `Based on the analysis of images in this folder, here's the main content: \n\n`;
                          
                          keySentences.forEach((sentence, index) => {
                              summary += `${index + 1}. ${sentence.trim()}\n\n`;
                          });
                          
                          // Add translated text summary if available
                          if (allTranslatedText) {
                              summary += isChinese ? `## 翻译内容分析\n\n` : `## Translated Content Analysis\n\n`;
                              const translatedSentences = allTranslatedText.split(/[.!?。！？]+/).filter(s => s.trim().length > 10);
                              const keyTranslatedSentences = translatedSentences.slice(0, 3);
                              
                              if (keyTranslatedSentences.length > 0) {
                                  keyTranslatedSentences.forEach((sentence, index) => {
                                      summary += `${index + 1}. ${sentence.trim()}\n\n`;
                                  });
                              } else {
                                  summary += isChinese ? `提取到了翻译内容，主要涉及：` : `Translated content was extracted, covering: `;
                                  const translatedKeywords = allTranslatedText.split(/\s+/).filter(word => word.length > 2);
                                  const uniqueTranslatedKeywords = Array.from(new Set(translatedKeywords)).slice(0, 8);
                                  summary += uniqueTranslatedKeywords.join(', ');
                                  summary += `\n\n`;
                              }
                          }
                          
                          if (keySentences.length === 0) {
                              // Fallback to brief overview if no meaningful sentences found
                              summary += isChinese ? `文件夹包含 ${allResults.length} 张图片，主要内容包括：\n\n` : `This folder contains ${allResults.length} images, with content including: \n\n`;
                              
                              // Extract unique keywords from all content including translated text
                              const allContentForKeywords = [
                                  ...allResults.map(r => r.description),
                                  ...allResults.map(r => r.translatedText),
                                  ...(allExtractedText ? [allExtractedText] : [])
                              ].join(' ');
                              
                              const allKeywords = allContentForKeywords
                                  .split(/\s+/)
                                  .filter(word => word.length > 2)
                                  .reduce((acc, word) => {
                                      acc[word] = (acc[word] || 0) + 1;
                                      return acc;
                                  }, {} as Record<string, number>);
                              
                              // Get top 10 keywords
                              const topKeywords = Object.entries(allKeywords)
                                  .sort(([, a], [, b]) => b - a)
                                  .slice(0, 10)
                                  .map(([word]) => word);
                              
                              summary += topKeywords.join(', ');
                          }
                      }
                      
                      // Step 5: Update folder description with AI-generated analysis
                      updateTask(taskId, { current: 5, currentStep: t('tasks.updatingFolder') });
                      setState(prev => ({
                          ...prev,
                          files: {
                              ...prev.files,
                              [folderId]: {
                                  ...prev.files[folderId],
                                  description: summary
                              }
                          }
                      }));
                  } catch (err) {
                      console.error('Failed to generate AI analysis', err);
                      // Fallback to intelligent summary if AI generation fails
                      const isChinese = state.settings.language === 'zh';
                      let summary = isChinese ? `## 图片分析汇总\n\n` : `## Image Analysis Summary\n\n`;
                       
                      // Create a comprehensive summary by combining all descriptions, translated text, and extracted text
                      const combinedContent = [
                          ...allResults.filter(r => r.description).map(r => r.description),
                          ...allResults.filter(r => r.translatedText).map(r => r.translatedText),
                          ...(allExtractedText ? [allExtractedText] : [])
                      ].join(' ');
                      
                      // Extract key sentences and keywords
                      const sentences = combinedContent.split(/[.!?。！？]+/).filter(s => s.trim().length > 10);
                      const keySentences = sentences.slice(0, 5); // Take first 5 meaningful sentences
                      
                      summary += isChinese ? `基于对文件夹内图片的分析，以下是主要内容：\n\n` : `Based on the analysis of images in this folder, here's the main content: \n\n`;
                      
                      if (keySentences.length > 0) {
                          keySentences.forEach((sentence, index) => {
                              summary += `${index + 1}. ${sentence.trim()}\n\n`;
                          });
                      }
                      
                      // Add translated text summary if available
                      if (allTranslatedText) {
                          summary += isChinese ? `## 翻译内容分析\n\n` : `## Translated Content Analysis\n\n`;
                          const translatedSentences = allTranslatedText.split(/[.!?。！？]+/).filter(s => s.trim().length > 10);
                          const keyTranslatedSentences = translatedSentences.slice(0, 3);
                          
                          if (keyTranslatedSentences.length > 0) {
                              keyTranslatedSentences.forEach((sentence, index) => {
                                  summary += `${index + 1}. ${sentence.trim()}\n\n`;
                              });
                          } else {
                              summary += isChinese ? `提取到了翻译内容，主要涉及：` : `Translated content was extracted, covering: `;
                              const translatedKeywords = allTranslatedText.split(/\s+/).filter(word => word.length > 2);
                              const uniqueTranslatedKeywords = Array.from(new Set(translatedKeywords)).slice(0, 8);
                              summary += uniqueTranslatedKeywords.join(', ');
                              summary += `\n\n`;
                          }
                      }
                      
                      if (keySentences.length === 0) {
                          // Extract unique keywords from all content including translated text
                          const allContentForKeywords = [
                              ...allResults.map(r => r.description),
                              ...allResults.map(r => r.translatedText),
                              ...(allExtractedText ? [allExtractedText] : [])
                          ].join(' ');
                          
                          const allKeywords = allContentForKeywords
                              .split(/\s+/)
                              .filter(word => word.length > 2)
                              .reduce((acc, word) => {
                                  acc[word] = (acc[word] || 0) + 1;
                                  return acc;
                              }, {} as Record<string, number>);
                          
                          // Get top 10 keywords
                          const topKeywords = Object.entries(allKeywords)
                              .sort(([, a], [, b]) => b - a)
                              .slice(0, 10)
                              .map(([word]) => word);
                          
                          summary += isChinese ? `文件夹包含 ${allResults.length} 张图片，主要内容包括：\n\n` : `This folder contains ${allResults.length} images, with content including: \n\n`;
                          summary += topKeywords.join(', ');
                      }
                      
                      // Update folder description with intelligent fallback summary
                      setState(prev => ({
                          ...prev,
                          files: {
                              ...prev.files,
                              [folderId]: {
                                  ...prev.files[folderId],
                                  description: summary
                              }
                          }
                      }));
                  }
              }
          }
          
          // Finish the task
          setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 1000);
          showToast(t('settings.aiAnalyzeSuccess'));
          return;
      }
      
      if (imageFileIds.length === 0) return;

      // Use software language setting for all AI outputs, including translations
      const transTarget = targetLanguage;

      // Create prompt in the same language as software settings
      const isChinese = state.settings.language === 'zh';
      
      let promptFields: string[] = [];
      
      // Only include description if autoDescription is enabled
      if (aiConfig.autoDescription) {
          promptFields.push(isChinese ? `- description: string (请简单描述这张图里的内容。${aiConfig.enhancePersonDescription ? '着重描述图片里的人物行为。并且对人物体型进行说明。' : ''})` : `- description: string (Please briefly describe the content of this image.${aiConfig.enhancePersonDescription ? ' Emphasize describing people\'s actions. Also provide a description of people\'s body types.' : ''})`);
      }

      // Only include OCR if enableOCR is enabled
      if (aiConfig.enableOCR) {
          promptFields.push(isChinese ? `- extractedText: string (提取图片中的文字。)` : `- extractedText: string (Extract text from the image.)`);
      }

      // Only include translation if enableTranslation is enabled
      if (aiConfig.enableTranslation) {
          promptFields.push(isChinese ? `- translatedText: string (把图片中的文字翻译成${transTarget}。)` : `- translatedText: string (Translate text from the image to ${transTarget}.)`);
      }

      // Only include tags if autoTag is enabled
      if (aiConfig.autoTag) {
          promptFields.push(`- tags: string[] (relevant keywords in ${targetLanguage})`);
      }

      // Only include people if enableFaceRecognition is enabled
      if (aiConfig.enableFaceRecognition) {
          promptFields.push(`- people: string[] (list of distinct people identified, if any, in ${targetLanguage})`);
      }

      // Always include sceneCategory, objects, and dominantColors for internal use
      promptFields.push(`- sceneCategory: string (e.g. landscape, portrait, indoor, etc in ${targetLanguage})`);
      promptFields.push(`- objects: string[] (list of visible objects in ${targetLanguage})`);
      promptFields.push(`- dominantColors: string[] (hex codes if detected, optional)`);
      
      const prompt = isChinese ? `Analyze this image. Return a VALID JSON object (no markdown, no extra text) with these fields:
      ${promptFields.join('\n      ')}
      
      Respond STRICTLY in JSON.
      ` : `Analyze this image. Return a VALID JSON object (no markdown, no extra text) with these fields:
      ${promptFields.join('\n      ')}
      
      Respond STRICTLY in JSON.
      `;

      // Each file has several steps, so total is image count * steps per file
      const stepsPerFile = 6; // Steps: 1. Read file, 2. AI call, 3. Process result, 4. Update description, 5. Add tags, 6. Process other AI data
      const totalSteps = imageFileIds.length * stepsPerFile;
      const taskId = startTask('ai', [], t('tasks.aiAnalysis'), false);
      
      // Update task with correct total steps
      updateTask(taskId, { total: totalSteps, current: 0 });

      // Store all AI results for folder summary
      const allResults: { description: string; translatedText?: string; extractedText?: string; }[] = [];
      
      // Initialize currentPeople outside the loop to share across all files
      let currentPeople = { ...state.people };

      try {
          // Process files one by one with real progress updates
          for (let fileIndex = 0; fileIndex < imageFileIds.length; fileIndex++) {
              const fileId = imageFileIds[fileIndex];
              const file = state.files[fileId];
              if (!file || file.type !== FileType.IMAGE) continue;
              
              let currentStep = fileIndex * stepsPerFile;
              
              // Step 1: Read file and convert to Base64
              updateTask(taskId, { current: currentStep + 1, currentStep: t('tasks.readingFile') });
              let base64Data = '';
              if (file.path) {
                  // In Tauri, use readFileAsBase64 instead of file.url
                  try {
                      const { readFileAsBase64 } = await import('./api/tauri-bridge');
                      const dataUrl = await readFileAsBase64(file.path);
                      if (dataUrl) {
                          base64Data = dataUrl.split(',')[1]; // Extract base64 part
                      }
                  } catch (e) {
                      console.warn("Failed to read file as base64 for AI", e);
                  }
              }

              if (!base64Data) continue;

              // Step 2: Call AI API for analysis
              updateTask(taskId, { current: currentStep + 2, currentStep: t('tasks.aiAnalyzing') });
              let result: any = null;
              let provider = aiConfig.provider;
              
              const parseJSON = (text: string) => {
                  try {
                      const jsonMatch = text.match(/\{[\s\S]*\}/);
                      if (jsonMatch) return JSON.parse(jsonMatch[0]);
                      return JSON.parse(text);
                  } catch (e) {
                      console.error("JSON Parse Error", e, text);
                      return null;
                  }
              };

              if (provider === 'openai') {
                  // ... (keep openai logic)
                  const body = {
                      model: aiConfig.openai.model,
                      messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Data}` } }] }],
                      max_tokens: 1000
                  };
                  try {
                      const res = await fetch(`${aiConfig.openai.endpoint}/chat/completions`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiConfig.openai.apiKey}` },
                          body: JSON.stringify(body)
                      });
                      const resData = await res.json();
                      if (resData?.choices?.[0]?.message?.content) { result = parseJSON(resData.choices[0].message.content); }
                  } catch (e) {
                      console.error('AI analysis failed:', e);
                  }
              } else if (provider === 'ollama') {
                  // ... (keep ollama logic)
                  const body = { model: aiConfig.ollama.model, prompt: prompt, images: [base64Data], stream: false, format: "json" };
                  try {
                      const res = await fetch(`${aiConfig.ollama.endpoint}/api/generate`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(body)
                      });
                      const resData = await res.json();
                      if (resData?.response) { result = parseJSON(resData.response); }
                  } catch (e) {
                      console.error('AI analysis failed:', e);
                  }
              } else if (provider === 'lmstudio') {
                  // ... (keep lmstudio logic)
                  const body = { model: aiConfig.lmstudio.model, messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Data}` } }] }], max_tokens: 1000, stream: false };
                  let endpoint = aiConfig.lmstudio.endpoint.replace(/\/+$/, '');
                  if (!endpoint.endsWith('/v1')) endpoint += '/v1';
                  try {
                      const res = await fetch(`${endpoint}/chat/completions`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(body)
                      });
                      const resData = await res.json();
                      if (resData?.choices?.[0]?.message?.content) { result = parseJSON(resData.choices[0].message.content); }
                  } catch (e) {
                      console.error('AI analysis failed:', e);
                  }
              }

              if (!result) continue;
              
              // Store result for folder summary
              allResults.push({
                  description: result.description || '',
                  translatedText: result.translatedText,
                  extractedText: result.extractedText || ''
              });
              
              // Step 3: Process AI response
              updateTask(taskId, { current: currentStep + 3, currentStep: t('tasks.processingResult') });
              let peopleUpdated = false;
              
              // Create aiData object with filtered fields based on settings
              const baseAiData: Partial<AiData> = {
                  analyzed: true,
                  analyzedAt: new Date().toISOString(),
                  description: aiConfig.autoDescription ? (result.description || '') : '',
                  tags: aiConfig.autoTag && Array.isArray(result.tags) ? result.tags : [],
                  sceneCategory: result.sceneCategory || 'General',
                  confidence: 0.95,
                  dominantColors: Array.isArray(result.dominantColors) ? result.dominantColors : [],
                  objects: Array.isArray(result.objects) ? result.objects : [],
                  extractedText: aiConfig.enableOCR ? result.extractedText : undefined,
                  translatedText: aiConfig.enableTranslation ? result.translatedText : undefined
              };
              
              // Step 3.1: Use face recognition service to get real face data if enabled
              // Initialize aiData with default values
              let aiData: AiData = {
                  ...baseAiData,
                  faces: [],
              } as AiData;
              
              if (aiConfig.enableFaceRecognition) {
                  // Use the actual file path for face recognition
                  const imagePath = file.path || '';
                  // Add current people database to settings for face recognition
                  const settingsWithPeople = {
                      ...state.settings,
                      people: currentPeople
                  };
                  const { aiData: aiResultData, faceDescriptors } = await aiService.analyzeImage(imagePath, settingsWithPeople, currentPeople);
                  
                  aiData = {
                      ...baseAiData,
                      faces: aiResultData.faces || [],
                  } as AiData;
                  
                  // Update people database with recognized faces
                  aiData.faces.forEach((face, index) => {
                      if (face.personId && face.name) {
                          // Get corresponding face descriptor
                          const faceDescriptor = faceDescriptors.find(fd => fd.faceId === face.id);
                          
                          // Calculate face box percentages if we have image dimensions
                          let faceBox: { x: number; y: number; w: number; h: number } | undefined;
                          if (file.meta?.width && file.meta?.height && face.box) {
                              const { x, y, w, h } = face.box;
                              faceBox = {
                                  x: Math.round((x / file.meta.width) * 100),
                                  y: Math.round((y / file.meta.height) * 100),
                                  w: Math.round((w / file.meta.width) * 100),
                                  h: Math.round((h / file.meta.height) * 100)
                              };
                          }
                          
                          // Check if person already exists
                          let person = currentPeople[face.personId];
                          
                          if (!person) {
                              if (state.settings.ai.autoAddPeople) {
                                  // Create new person
                                  currentPeople[face.personId] = {
                                      id: face.personId,
                                      name: face.name,
                                      coverFileId: fileId,
                                      count: 1,
                                      description: 'Detected by AI face recognition',
                                      descriptor: faceDescriptor?.descriptor,
                                      faceBox: faceBox
                                  };
                                  peopleUpdated = true;
                              }
                          } else {
                              // Update existing person count, and add descriptor if not already present
                              currentPeople[face.personId] = {
                                  ...person,
                                  count: person.count + 1,
                                  descriptor: person.descriptor || faceDescriptor?.descriptor,
                                  faceBox: person.faceBox || faceBox
                              };
                              peopleUpdated = true;
                          }
                      }
                  });
              } 
              
              // Always process people from AI API response regardless of face recognition setting
              if (result.people && Array.isArray(result.people)) {
                  const aiFaces: AiFace[] = [];
                  
                  result.people.forEach((name: string) => {
                      // For AI API detected people, be cautious with generic names
                      // Don't automatically merge by name for generic terms like "女性"
                      const isGenericName = name.toLowerCase() === '女性' || name.toLowerCase() === 'female' || 
                                          name.toLowerCase() === '男性' || name.toLowerCase() === 'male' ||
                                          name.toLowerCase() === 'person' || name.toLowerCase() === 'people';
                      
                      if (!isGenericName) {
                      // Check if person already exists by name
                      let personId = Object.keys(currentPeople).find(pid => currentPeople[pid].name.toLowerCase() === name.toLowerCase());
                      
                      if (!personId) {
                          if (state.settings.ai.autoAddPeople) {
                              // Create new person
                              personId = Math.random().toString(36).substr(2, 9);
                              currentPeople[personId] = {
                                  id: personId,
                                  name: name,
                                  coverFileId: fileId,
                                  count: 1,
                                  description: 'Detected by AI'
                              };
                              peopleUpdated = true;
                          }
                      } else {
                          // Update existing person count
                          currentPeople[personId] = {
                              ...currentPeople[personId],
                              count: currentPeople[personId].count + 1
                          };
                          peopleUpdated = true;
                      }
                      
                      if (personId) {
                          // Add face to AI data
                          aiFaces.push({
                              id: Math.random().toString(36).substr(2, 9),
                              personId: personId,
                              name: name,
                              confidence: 0.95,
                              box: { x: 0, y: 0, w: 0, h: 0 }
                          });
                      }
                      }
                  });
                  
                  // Merge AI detected faces with existing faces, avoiding duplicates
                  const existingPersonIds = new Set(aiData.faces.map(face => face.personId));
                  const newAIFaces = aiFaces.filter(face => !existingPersonIds.has(face.personId));
                  aiData.faces = [...aiData.faces, ...newAIFaces];
              }

              // Step 4: Update description only if autoDescription is enabled
              updateTask(taskId, { current: currentStep + 4, currentStep: t('tasks.updatingDescription') });
              
              // Step 5: Add tags only if autoTag is enabled
              updateTask(taskId, { current: currentStep + 5, currentStep: t('tasks.addingTags') });
              const currentTags = file.tags || [];
              const newTags = aiConfig.autoTag ? Array.from(new Set([...currentTags, ...aiData.tags])) : currentTags;

              // Step 6: Save all AI data
              updateTask(taskId, { current: currentStep + 6, currentStep: t('tasks.savingData') });
              const updatedFile = {
                  ...file,
                  aiData,
                  tags: newTags,
                  description: file.description ? file.description : (aiConfig.autoDescription ? aiData.description : '')
              };

              setState(prev => ({
                  ...prev,
                  people: currentPeople, // Always use the latest shared currentPeople
                  files: {
                      ...prev.files,
                      [fileId]: updatedFile
                  }
              }));
          }
          
          // If folderId is provided, summarize all results and update folder description
          if (folderId) {
              updateTask(taskId, { current: totalSteps, currentStep: t('tasks.summarizing') });
              const folder = state.files[folderId];
              if (folder) {
                  // Prepare all content (descriptions, extracted text, translated text) into a single text block
                  const allContent = allResults
                      .map((result, index) => {
                          let content = `Image ${index + 1}: ${result.description || 'No description'}`;
                          if (result.extractedText) {
                              content += `\nExtracted Text: ${result.extractedText}`;
                          }
                          if (result.translatedText) {
                              content += `\nTranslated Text: ${result.translatedText}`;
                          }
                          return content;
                      })
                      .join('\n\n');
                  
                  if (allContent) {
                      const aiConfig = state.settings.ai;
                      let summary = '';
                      
                      // Determine output language based on software settings
                      const isChinese = state.settings.language === 'zh';
                      const outputLanguage = isChinese ? '中文' : 'English';
                      
                      // Create prompt for AI to understand and provide detailed summary of the folder content
                      const analysisPrompt = isChinese ? 
                      `请根据以下所有图片的描述、提取到的文字和翻译后的文字，详细分析这个文件夹内的图片内容以及这些文字说了个什么事情？\n\n${allContent}\n\n请严格遵守以下要求：\n1. ❌绝对禁止直接罗列单张图片的描述信息，例如"图片1：...图片2：..."这样的格式\n2. ✅必须将所有图片的描述信息结合成一个整体进行分析，形成连贯的整体描述\n3. ✅详细说明这些图片和文字所描述的整体事件、主题或故事\n4. ✅如果你发现有提取到的文字，请优先使用翻译后的文字（如果有），否则使用提取到的文字，提炼重要内容并对此进行讲解\n5. ✅请用清晰、有条理的语言进行分析和总结，不要过于简洁\n6. ✅你的回答应该像是对整个文件夹内容的总体概括，而不是对每张图片的单独描述` :
                      `Based on all the image descriptions, extracted text, and translated text below, please analyze in detail what these images are about and what story or information the text conveys.\n\n${allContent}\n\nPlease strictly follow these requirements:\n1. ❌ ABSOLUTELY DO NOT directly list individual image descriptions, such as "Image 1: ... Image 2: ..." format\n2. ✅ Must combine all image descriptions into a single coherent analysis, forming a continuous overall description\n3. ✅ Provide a detailed explanation of the overall events, themes, or stories described in these images and text\n4. ✅ If you find any extracted text, please prioritize using translated text (if available), otherwise use the extracted text, extract important content and explain it\n5. ✅ Use clear, structured language for analysis and summary, avoid being too concise\n6. ✅ Your answer should be an overall summary of the entire folder content, not a separate description of each image`;
                      
                      try {
                          let result: any = null;
                          
                          if (aiConfig.provider === 'openai') {
                              const body = {
                                  model: aiConfig.openai.model,
                                  messages: [{ role: "user", content: analysisPrompt }],
                                  max_tokens: 1500,
                                  temperature: 0.7
                              };
                              const res = await fetch(`${aiConfig.openai.endpoint}/chat/completions`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiConfig.openai.apiKey}` },
                                  body: JSON.stringify(body)
                              });
                              const resData = await res.json();
                              if (resData?.choices?.[0]?.message?.content) { 
                                  summary = resData.choices[0].message.content;
                              }
                          } else if (aiConfig.provider === 'ollama') {
                              const body = { 
                                  model: aiConfig.ollama.model, 
                                  prompt: analysisPrompt, 
                                  stream: false,
                                  temperature: 0.7
                              };
                              const res = await fetch(`${aiConfig.ollama.endpoint}/api/generate`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify(body)
                              });
                              const resData = await res.json();
                              if (resData?.response) { 
                                  summary = resData.response;
                              }
                          } else if (aiConfig.provider === 'lmstudio') {
                              let endpoint = aiConfig.lmstudio.endpoint.replace(/\/+$/, '');
                              if (!endpoint.endsWith('/v1')) endpoint += '/v1';
                              const body = {
                                  model: aiConfig.lmstudio.model,
                                  messages: [{ role: "user", content: analysisPrompt }],
                                  max_tokens: 1500,
                                  temperature: 0.7,
                                  stream: false
                              };
                              const res = await fetch(`${endpoint}/chat/completions`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify(body)
                              });
                              const resData = await res.json();
                              if (resData?.choices?.[0]?.message?.content) { 
                                  summary = resData.choices[0].message.content;
                              }
                          }
                          
                          // If AI failed to generate analysis, fall back to a better summary that doesn't list individual images
                          if (!summary) {
                              const isChinese = state.settings.language === 'zh';
                              summary = isChinese ? `## 图片分析汇总\n\n` : `## Image Analysis Summary\n\n`;
                              
                              // Extract all descriptions without numbering
                              const allDescriptions = allResults
                                  .map(r => r.description || '')
                                  .filter(Boolean)
                                  .join(' ');
                              
                              // Extract all texts
                              const allTexts: string[] = [];
                              allResults.forEach(r => {
                                  if (r.translatedText) allTexts.push(r.translatedText);
                                  else if (r.extractedText) allTexts.push(r.extractedText);
                              });
                              
                              // Create a coherent fallback summary
                              if (allDescriptions) {
                                  summary += isChinese ? 
                                      `本文件夹包含多张图片，主要内容是：${allDescriptions.substring(0, 500)}${allDescriptions.length > 500 ? '...' : ''}` :
                                      `This folder contains multiple images, with main content: ${allDescriptions.substring(0, 500)}${allDescriptions.length > 500 ? '...' : ''}`;
                              }
                              
                              if (allTexts.length > 0) {
                                  summary += isChinese ? `\n\n提取到的文字内容：${allTexts.join('; ').substring(0, 300)}${allTexts.join('; ').length > 300 ? '...' : ''}` :
                                      `\n\nExtracted text content: ${allTexts.join('; ').substring(0, 300)}${allTexts.join('; ').length > 300 ? '...' : ''}`;
                              }
                          }
                      } catch (err) {
                          console.error('Failed to generate AI analysis', err);
                          // Fallback to a better summary that doesn't list individual images
                          const isChinese = state.settings.language === 'zh';
                          summary = isChinese ? `## 图片分析汇总\n\n` : `## Image Analysis Summary\n\n`;
                          
                          // Extract all descriptions without numbering
                          const allDescriptions = allResults
                              .map(r => r.description || '')
                              .filter(Boolean)
                              .join(' ');
                          
                          // Extract all texts
                          const allTexts: string[] = [];
                          allResults.forEach(r => {
                              if (r.translatedText) allTexts.push(r.translatedText);
                              else if (r.extractedText) allTexts.push(r.extractedText);
                          });
                          
                          // Create a coherent fallback summary
                          if (allDescriptions) {
                              summary += isChinese ? 
                                  `本文件夹包含多张图片，主要内容是：${allDescriptions.substring(0, 500)}${allDescriptions.length > 500 ? '...' : ''}` :
                                  `This folder contains multiple images, with main content: ${allDescriptions.substring(0, 500)}${allDescriptions.length > 500 ? '...' : ''}`;
                          }
                          
                          if (allTexts.length > 0) {
                              summary += isChinese ? `\n\n提取到的文字内容：${allTexts.join('; ').substring(0, 300)}${allTexts.join('; ').length > 300 ? '...' : ''}` :
                                  `\n\nExtracted text content: ${allTexts.join('; ').substring(0, 300)}${allTexts.join('; ').length > 300 ? '...' : ''}`;
                          }
                      }
                      
                      // Update folder description with AI-generated story
                      setState(prev => ({
                          ...prev,
                          files: {
                              ...prev.files,
                              [folderId]: {
                                  ...prev.files[folderId],
                                  description: summary
                              }
                          }
                      }));
                  }
              }
          }
          
          showToast(t('settings.aiAnalyzeSuccess'));

      } catch (err) {
          console.error(err);
          showToast("AI Analysis Failed");
      } finally {
          updateTask(taskId, { status: 'completed', currentStep: t('tasks.completed') });
          setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 1000);
      }
  };
  
  // Function to analyze all files in a folder
  const handleFolderAIAnalysis = async (folderId: string) => {
      // Get all image files in the folder and check their AI analysis status
      const getAllImageFilesInFolder = (folderId: string): { id: string; analyzed: boolean }[] => {
          const folder = state.files[folderId];
          if (!folder) return [];
          
          let imageFiles: { id: string; analyzed: boolean }[] = [];
          
          if (folder.children) {
              for (const childId of folder.children) {
                  const child = state.files[childId];
                  if (child) {
                      if (child.type === FileType.FOLDER) {
                          // Recursively get files from subfolders
                          imageFiles = [...imageFiles, ...getAllImageFilesInFolder(childId)];
                      } else if (child.type === FileType.IMAGE) {
                          // Check if image has been analyzed
                          const analyzed = !!child.aiData?.analyzed;
                          imageFiles.push({ id: childId, analyzed });
                      }
                  }
              }
          }
          
          return imageFiles;
      };
      
      // Get all image files with their analysis status
      const allImageFiles = getAllImageFilesInFolder(folderId);
      
      // Filter out non-image files and get all image IDs
      const allImageIds = allImageFiles.map(file => file.id);
      
      if (allImageIds.length === 0) return;
      
      // Get IDs of images that haven't been analyzed yet
      const unanalyzedImageIds = allImageFiles.filter(file => !file.analyzed).map(file => file.id);
      
      if (unanalyzedImageIds.length > 0) {
          // If there are unanalyzed images, analyze them first
          await handleAIAnalysis(unanalyzedImageIds, folderId);
      } else {
          // If all images are already analyzed, just generate the summary
          // We'll call handleAIAnalysis with empty array and folderId to trigger summary generation
          await handleAIAnalysis([], folderId);
      }
  };

  return (
    <div 
      className="w-full h-full flex flex-col bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 overflow-hidden font-sans transition-colors duration-300" 
      onClick={closeContextMenu}
      onDragEnter={handleExternalDragEnter}
      onDragOver={handleExternalDragOver}
      onDrop={handleExternalDrop}
      onDragLeave={handleExternalDragLeave}
    >
      {/* 启动界面 */}
      <SplashScreen isVisible={showSplash} loadingInfo={loadingInfo} />
      
      {/* 外部拖拽覆盖层 */}
      <DragDropOverlay 
        isVisible={isExternalDragging}
        fileCount={externalDragItems.length}
        hoveredAction={hoveredDropAction}
        onHoverAction={setHoveredDropAction}
        t={t}
      />
      
      {/* ... (SVG filters) ... */}
      <svg style={{ display: 'none' }}><defs><filter id="channel-r"><feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" /></filter><filter id="channel-g"><feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" /></filter><filter id="channel-b"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" /></filter><filter id="channel-l"><feColorMatrix type="saturate" values="0" /></filter></defs></svg>
      <TabBar tabs={state.tabs} activeTabId={state.activeTabId} files={state.files} onSwitchTab={handleSwitchTab} onCloseTab={handleCloseTab} onNewTab={handleNewTab} onContextMenu={(e, id) => handleContextMenu(e, 'tab', id)} onCloseWindow={async () => {
        // Check user's exit action preference from ref (always latest value)
        const exitAction = exitActionRef.current;

        if (exitAction === 'minimize') {
          // Minimize to tray
          await hideWindow();
        } else if (exitAction === 'exit') {
          // Exit immediately
          await exitApp();
        } else {
          // Ask user (default behavior)
          setShowCloseConfirmation(true);
        }
      }} t={t} showWindowControls={!showSplash} />
      <div className="flex-1 flex overflow-hidden relative transition-all duration-300 ease-[cubic-bezier(0.25,0.1,0.25,1)]">
        <div className={`bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col transition-all duration-300 shrink-0 z-40 ${state.layout.isSidebarVisible ? 'w-64 translate-x-0 opacity-100' : 'w-0 -translate-x-full opacity-0 overflow-hidden'}`}>
          <Sidebar roots={state.roots} files={state.files} people={state.people} customTags={state.customTags} currentFolderId={activeTab.folderId} expandedIds={state.expandedFolderIds} tasks={state.tasks} onToggle={handleToggleFolder} onNavigate={handleNavigateFolder} onTagSelect={enterTagView} onNavigateAllTags={enterTagsOverview} onPersonSelect={enterPersonView} onNavigateAllPeople={enterPeopleOverview} onContextMenu={handleContextMenu} isCreatingTag={isCreatingTag} onStartCreateTag={handleCreateNewTag} onSaveNewTag={handleSaveNewTag} onCancelCreateTag={handleCancelCreateTag} onOpenSettings={toggleSettings} onRestoreTask={onRestoreTask} onPauseResume={onPauseResume} onStartRenamePerson={onStartRenamePerson} onCreatePerson={handleCreatePerson} onNavigateTopics={handleNavigateTopics} onCreateTopic={() => handleCreateTopic(null)} onDropOnFolder={handleDropOnFolder} t={t} />
        </div>
        
        <div className="flex-1 flex flex-col min-w-0 relative bg-white dark:bg-gray-950">
          {activeTab.viewingFileId && (
              (() => {
                  const viewingFile = state.files[activeTab.viewingFileId];
                  const parentFolder = viewingFile && viewingFile.parentId ? state.files[viewingFile.parentId] : null;
                  
                  if (parentFolder && parentFolder.category === 'sequence') {
                      return (
                          <SequenceViewer
                              file={viewingFile}
                              folder={parentFolder}
                              files={state.files}
                              sortedFileIds={displayFileIds.filter(id => state.files[id].type === FileType.IMAGE)}
                              onClose={closeViewer}
                              onNavigate={handleViewerJump}
                              isSidebarOpen={state.layout.isSidebarVisible}
                              onToggleSidebar={() => setState(s => ({ ...s, layout: { ...s.layout, isSidebarVisible: !s.layout.isSidebarVisible } }))}
                              onDelete={(id) => requestDelete([id])}
                              t={t}
                          />
                      );
                  }

                  return (
                      <ImageViewer
                          file={state.files[activeTab.viewingFileId]}
                          sortedFileIds={displayFileIds.filter(id => state.files[id].type === FileType.IMAGE)} 
                          files={state.files}
                          layout={state.layout}
                          slideshowConfig={state.slideshowConfig}
                          onLayoutToggle={(part) => setState(s => ({ ...s, layout: { ...s.layout, [part === 'sidebar' ? 'isSidebarVisible' : 'isMetadataVisible']: !s.layout[part === 'sidebar' ? 'isSidebarVisible' : 'isMetadataVisible'] } }))}
                          onClose={closeViewer}
                          onNext={(random) => handleViewerNavigate(random ? 'random' : 'next')}
                          onPrev={() => handleViewerNavigate('prev')}
                          onNavigateBack={goBack}
                          onNavigateForward={goForward}
                          canGoBack={activeTab.history.currentIndex > 0}
                          canGoForward={activeTab.history.currentIndex < activeTab.history.stack.length - 1}
                          onDelete={(id) => requestDelete([id])}
                          onViewInExplorer={handleViewInExplorer}
                          onCopyToFolder={(fileId) => setState(s => ({ ...s, activeModal: { type: 'copy-to-folder', data: { fileIds: [fileId] } } }))}
                          onMoveToFolder={(fileId) => setState(s => ({ ...s, activeModal: { type: 'move-to-folder', data: { fileIds: [fileId] } } }))}
                          onNavigateToFolder={(fid) => enterFolder(fid)}
                          searchQuery={activeTab.searchQuery}
                          onSearch={handleViewerSearch}
                          searchScope={activeTab.searchScope}
                          onSearchScopeChange={(scope) => updateActiveTab({ searchScope: scope })}
                          onUpdateSlideshowConfig={(cfg) => setState(s => ({ ...s, slideshowConfig: cfg }))}
                          onPasteTags={(id) => handlePasteTags([id])}
                          onEditTags={() => setState(s => ({ ...s, activeModal: { type: 'edit-tags', data: { fileId: activeTab.viewingFileId } } }))}
                          onCopyTags={() => handleCopyTags([activeTab.viewingFileId!])}
                          onAIAnalysis={(id) => handleAIAnalysis([id])}
                          isAISearchEnabled={state.settings.search.isAISearchEnabled}
                          onToggleAISearch={() => setState(s => ({ ...s, settings: { ...s.settings, search: { ...s.settings.search, isAISearchEnabled: !s.settings.search.isAISearchEnabled } } }))}
                          t={t}
                          activeTab={activeTab}
                      />
                  );
              })()
          )}
          {!activeTab.viewingFileId && (
            <>
              <TopBar 
                activeTab={activeTab} 
                state={state} 
                toolbarQuery={toolbarQuery} 
                groupedTags={groupedTags} 
                tagSearchQuery={tagSearchQuery} 
                onToggleSidebar={() => setState(s => ({ ...s, layout: { ...s.layout, isSidebarVisible: !s.layout.isSidebarVisible } }))} 
                onGoBack={goBack} 
                onGoForward={goForward} 
                onNavigateUp={handleNavigateUp} 
                onSetTagSearchQuery={setTagSearchQuery} 
                onTagClick={handleTagClick} 
                onRefresh={handleRefresh} 
                onSearchScopeChange={(scope) => updateActiveTab({ searchScope: scope })} 
                onPerformSearch={handlePerformSearch} 
                onSetToolbarQuery={setToolbarQuery} 
                onLayoutModeChange={(mode) => updateActiveTab({ layoutMode: mode })} 
                onSortOptionChange={(opt) => setState(s => ({ ...s, sortBy: opt }))} 
                onSortDirectionChange={() => setState(s => ({ ...s, sortDirection: s.sortDirection === 'asc' ? 'desc' : 'asc' }))} 
                onThumbnailSizeChange={(size) => setState(s => ({ ...s, thumbnailSize: size }))} 
                onToggleMetadata={() => setState(s => ({ ...s, layout: { ...s.layout, isMetadataVisible: !s.layout.isMetadataVisible } }))} 
                onToggleSettings={toggleSettings} 
                onUpdateDateFilter={(f) => updateActiveTab({ dateFilter: f })} 
                groupBy={groupBy}
                onGroupByChange={setGroupBy}
                isAISearchEnabled={state.settings.search.isAISearchEnabled}
                onToggleAISearch={() => setState(s => ({ ...s, settings: { ...s.settings, search: { ...s.settings.search, isAISearchEnabled: !s.settings.search.isAISearchEnabled } } }))}
                onRememberFolderSettings={activeTab.viewMode === 'browser' ? handleRememberFolderSettings : undefined}
                hasFolderSettings={activeTab.viewMode === 'browser' ? !!state.folderSettings[activeTab.folderId] : false}
                t={t} 
              />
              {/* ... (Filter UI, same as before) ... */}
              {(activeTab.activeTags.length > 0 || activeTab.dateFilter.start || activeTab.activePersonId || activeTab.aiFilter) && ( 
                  <div className="flex items-center px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 space-x-2 overflow-x-auto shrink-0 z-20">
                      <div className="flex items-center text-xs text-gray-500 dark:text-gray-400 mr-2 shrink-0">
                          <Filter size={12} className="mr-1"/> {t('context.filters')}
                      </div>
                      
                      {activeTab.aiFilter && (
                          <div className="flex items-center bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-200 px-2 py-0.5 rounded-full text-xs border border-purple-200 dark:border-purple-800 whitespace-nowrap">
                              <Brain size={10} className="mr-1"/>
                              <span>{t('settings.aiSmartSearch')}: "{activeTab.aiFilter.originalQuery}"</span>
                              <button onClick={() => updateActiveTab({ aiFilter: null })} className="ml-1.5 hover:text-red-500"><X size={12}/></button>
                          </div>
                      )}

                      {activeTab.dateFilter.start && (
                          <div className="flex items-center bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 px-2 py-0.5 rounded-full text-xs border border-blue-200 dark:border-blue-800 whitespace-nowrap">
                              <Calendar size={10} className="mr-1"/>
                              <span>{new Date(activeTab.dateFilter.start).toLocaleDateString()} {activeTab.dateFilter.end ? `- ${new Date(activeTab.dateFilter.end).toLocaleDateString()}` : ''}</span>
                              <button onClick={() => updateActiveTab({ dateFilter: { start: null, end: null, mode: 'created' as const } })} className="ml-1.5 hover:text-red-500"><X size={12}/></button>
                          </div>
                      )}
                      
                      {activeTab.activePersonId && state.people[activeTab.activePersonId] && (
                          <div className="flex items-center bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-200 px-2 py-0.5 rounded-full text-xs border border-purple-200 dark:border-purple-800 whitespace-nowrap">
                              <Brain size={10} className="mr-1"/>
                              <span>{state.people[activeTab.activePersonId].name}</span>
                              <button onClick={() => handleClearPersonFilter()} className="ml-1.5 hover:text-red-500"><X size={12}/></button>
                          </div>
                      )}
                      
                      {activeTab.activeTags.map(tag => (
                          <div key={tag} className="flex items-center bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 px-2 py-0.5 rounded-full text-xs border border-blue-200 dark:border-blue-800 whitespace-nowrap">
                              <span>{tag}</span>
                              <button onClick={() => handleClearTagFilter(tag)} className="ml-1.5 hover:text-red-500"><X size={12}/></button>
                          </div>
                      ))}
                      
                      <button onClick={() => { handleClearAllTags(); handleClearPersonFilter(); updateActiveTab({ dateFilter: { start: null, end: null, mode: 'created' as const }, aiFilter: null }); }} className="text-xs text-gray-500 hover:text-red-500 underline ml-2 whitespace-nowrap">{t('context.clearAll')}</button>
                  </div>
              )}
              
              <div className="flex-1 flex flex-col relative bg-white dark:bg-gray-950 overflow-hidden">
                {activeTab.viewMode !== 'topics-overview' && (
                  <div className="h-14 flex items-center justify-between px-4 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-950/50 backdrop-blur shrink-0 relative z-20">
                    {activeTab.viewMode === 'tags-overview' ? (
                      <div className="flex items-center w-full">
                        <div className="flex items-center">
                          <Tag size={12} className="mr-1"/>
                          <span className="font-medium">{t('context.allTagsOverview')}</span>
                        </div>
                        <div className="flex-1 flex justify-end">
                          <div className="relative" style={{ width: '250px' }}>
                            <div className={`flex items-center bg-gray-100 dark:bg-gray-800 rounded-full px-3 py-1.5 transition-all border ${tagSearchQuery ? 'border-blue-500 shadow-sm' : 'border-transparent'}`}>
                              <Search size={14} className="mr-2 text-gray-400" />
                              <input
                                type="text"
                                placeholder={t('search.placeholder')}
                                value={tagSearchQuery}
                                onChange={(e) => setTagSearchQuery(e.target.value)}
                                className="bg-transparent border-none focus:outline-none text-sm w-full text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500"
                              />
                              {tagSearchQuery && (
                                <button
                                  onClick={() => setTagSearchQuery('')}
                                  className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400"
                                >
                                  <X size={12} />
                                </button>
                              )}
                            </div>
                            {/* 智能联想下拉列表 */}
                            {(() => {
                              const allTags = new Set<string>();
                              Object.values(state.files).forEach((f: any) => {
                                if (f.tags) {
                                  f.tags.forEach((t: string) => allTags.add(t));
                                }
                              });
                              state.customTags.forEach(t => allTags.add(t));
                              
                              const allTagsList = Array.from(allTags);
                              const filteredTags = allTagsList.filter(tag => 
                                tag.toLowerCase().includes(tagSearchQuery.toLowerCase())
                              );
                              
                              // 只有当有多个匹配标签或者当前搜索词与匹配标签不完全相同时才显示下拉列表
                              const shouldShow = tagSearchQuery && 
                                                filteredTags.length > 0 && 
                                                !(filteredTags.length === 1 && filteredTags[0] === tagSearchQuery);
                              
                              if (!shouldShow) return null;
                              
                              return (
                                <div className="absolute top-full left-0 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 mt-1 rounded-lg shadow-xl z-50 max-h-40 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600">
                                  {filteredTags.map(tag => (
                                    <div 
                                      key={tag} 
                                      className="px-4 py-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-sm cursor-pointer text-gray-800 dark:text-gray-200"
                                      onClick={() => setTagSearchQuery(tag)}
                                    >
                                      {tag}
                                    </div>
                                  ))}
                                </div>
                              );
                            })()}
                          </div>
                        </div>
                      </div>
                    ) : activeTab.viewMode === 'people-overview' ? (
                      <div className="flex items-center w-full justify-between">
                        <div className="flex items-center">
                          <User size={12} className="mr-1"/>
                          <span>{t('context.allPeople')}</span>
                        </div>
                        <div className="text-[10px] opacity-60">
                          {Object.keys(state.people).length} {t('context.items')}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center w-full justify-between">
                        <div className="flex items-center space-x-1 overflow-hidden">
                          <HardDrive size={12}/>
                          <span>/</span>
                          {state.files[activeTab.folderId]?.path || state.files[activeTab.folderId]?.name}
                          {activeTab.activeTags.length > 0 && <span className="text-blue-600 font-bold ml-2">{t('context.filtered')}</span>}
                        </div>
                        <div className="text-[10px] opacity-60">
                          {displayFileIds.length} {t('context.items')}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className="flex-1 overflow-hidden relative" id="file-grid-container">
                  {activeTab.viewMode === 'topics-overview' ? (
                     <TopicModule 
                        topics={state.topics}
                        files={state.files}
                        people={state.people}
                        currentTopicId={activeTab.activeTopicId || null}
                        selectedTopicIds={activeTab.selectedTopicIds || []} // Pass selectedTopicIds
                        onNavigateTopic={handleNavigateTopic}
                        onUpdateTopic={handleUpdateTopic}
                        onCreateTopic={handleCreateTopic}
                        onDeleteTopic={handleDeleteTopic}
                        onSelectTopics={(ids) => {
                             updateActiveTab({ selectedTopicIds: ids, selectedFileIds: [] });
                        }}
                        onSelectFiles={(ids) => {
                             updateActiveTab({ selectedFileIds: ids, selectedTopicIds: [] });
                        }}
                        t={t}
                     />
                  ) : displayFileIds.length === 0 && activeTab.viewMode === 'browser' ? (
                     <div className="w-full h-full flex flex-col items-center justify-center text-gray-400" onMouseDown={handleMouseDown} onContextMenu={(e) => handleContextMenu(e, 'background', '')}>
                        <div className="text-6xl mb-4 opacity-20"><FolderOpen/></div>
                        <p>{t('context.noFiles')}</p>
                     </div>
                  ) :  (
                    <FileGrid 
                        displayFileIds={displayFileIds} 
                        files={state.files} 
                        activeTab={activeTab} 
                        renamingId={state.renamingId} 
                        thumbnailSize={state.thumbnailSize} 
                        resourceRoot={state.settings.paths.resourceRoot}
                        cachePath={state.settings.paths.cacheRoot || (state.settings.paths.resourceRoot ? `${state.settings.paths.resourceRoot}${state.settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined)} 
                        hoverPlayingId={hoverPlayingId} 
                        onSetHoverPlayingId={setHoverPlayingId} 
                        onFileClick={handleFileClick} 
                        onFileDoubleClick={(id) => state.files[id]?.type === FileType.FOLDER ? handleNavigateFolder(id) : enterViewer(id)} 
                        onContextMenu={(e, id) => handleContextMenu(e, 'file', id)} 
                        onRenameSubmit={handleRenameSubmit} 
                        onRenameCancel={() => setState(s => ({ ...s, renamingId: null }))} 
                        onStartRename={startRename} 
                        settings={state.settings}
                        containerRef={selectionRef}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onBackgroundContextMenu={(e) => handleContextMenu(e, 'background', '')}
                        people={state.people}
                        groupedTags={groupedTags}
                        onPersonClick={(pid, e) => handlePersonClick(pid, e)}
                        onPersonContextMenu={(e, pid) => handleContextMenu(e, 'person', pid)}
                        onPersonDoubleClick={(pid) => enterPersonView(pid)}
                        onStartRenamePerson={(personId) => setState(s => ({ ...s, activeModal: { type: 'rename-person', data: { personId } } }))}
                        onTagClick={(tag, e) => handleOverviewTagClick(tag, e)}
                        onTagContextMenu={(e, tag) => handleContextMenu(e, 'tag', tag)}
                        onTagDoubleClick={(tag) => enterTagView(tag)}
                        groupedFiles={groupedFiles}
                        groupBy={groupBy}
                        collapsedGroups={collapsedGroups}
                        onToggleGroup={toggleGroup}
                        isSelecting={isSelecting}
                        selectionBox={selectionBox}
                        onScrollTopChange={(scrollTop) => updateActiveTab({ scrollTop })}
                        t={t} 
                        onThumbnailSizeChange={(size) => setState(s => ({ ...s, thumbnailSize: size }))}
                        onUpdateFile={handleUpdateFile}
                        onDropOnFolder={handleDropOnFolder}
                        onDragStart={(fileIds) => setState(s => ({ ...s, dragState: { ...s.dragState, isDragging: true, draggedFileIds: fileIds } }))}
                        onDragEnd={() => setState(s => ({ ...s, dragState: { ...s.dragState, isDragging: false } }))}
                        isDraggingOver={isExternalDragging}
                        dragOverTarget={state.dragState.dragOverFolderId}
                        isDraggingInternal={isDraggingInternal}
                        setIsDraggingInternal={setIsDraggingInternal}
                        setDraggedFilePaths={setDraggedFilePaths}
                    />
                  )}
                </div>
              </div>
            </>
          )}
        </div>
        <div className={`metadata-panel-container bg-gray-50 dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 flex flex-col transition-all duration-300 shrink-0 z-40 ${state.layout.isMetadataVisible ? 'w-80 translate-x-0 opacity-100' : 'w-0 translate-x-full opacity-0 overflow-hidden'}`}>
          <MetadataPanel files={state.files} selectedFileIds={activeTab.selectedFileIds} people={state.people} selectedPersonIds={activeTab.selectedPersonIds} onUpdate={handleUpdateFile} onUpdatePerson={handleUpdatePerson} onNavigateToFolder={handleNavigateFolder} onNavigateToTag={enterTagView} onSearch={onPerformSearch} t={t} activeTab={activeTab} resourceRoot={state.settings.paths.resourceRoot} cachePath={state.settings.paths.cacheRoot || (state.settings.paths.resourceRoot ? `${state.settings.paths.resourceRoot}${state.settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined)} />
        </div>
        <TaskProgressModal tasks={state.tasks} onMinimize={minimizeTask} onClose={(id: string) => setState(s => ({ ...s, tasks: s.tasks.filter(t => t.id !== id) }))} t={t} onPauseResume={onPauseResume} />
        <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 z-[110] flex flex-col-reverse items-center gap-2 pointer-events-none">
          {deletionTasks.map(task => ( <ToastItem key={task.id} task={task} onUndo={() => undoDelete(task.id)} onDismiss={() => dismissDelete(task.id)} t={t} /> ))}
          {toast.visible && ( <div className="bg-black/80 text-white text-sm px-4 py-2 rounded-full shadow-lg backdrop-blur-sm animate-toast-up">{toast.msg}</div> )}
          {showDragHint && ( <div className="bg-blue-600 dark:bg-blue-700 text-white text-sm px-4 py-2.5 rounded-full shadow-lg backdrop-blur-sm animate-toast-up flex items-center gap-2 pointer-events-auto">
            <span>{t('drag.multiSelectHint')}</span>
          </div> )}
        </div>
      </div>
      
      {/* ... (Modals Logic) ... */}
      {state.activeModal.type && ( <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">{state.activeModal.type === 'alert' && state.activeModal.data && ( <AlertModal message={state.activeModal.data.message} onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))} t={t} /> )}{state.activeModal.type === 'add-to-person' && ( <AddToPersonModal people={state.people} files={state.files} onConfirm={handleManualAddPerson} onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))} t={t} /> )}{state.activeModal.type === 'add-to-topic' && ( <AddToTopicModal topics={state.topics} onConfirm={handleManualAddToTopic} onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))} t={t} /> )}{state.activeModal.type === 'rename-tag' && state.activeModal.data && ( <RenameTagModal initialTag={state.activeModal.data.tag} onConfirm={handleRenameTag} onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))} t={t} /> )}{state.activeModal.type === 'batch-rename' && ( <BatchRenameModal count={activeTab.selectedFileIds.length} onConfirm={handleBatchRename} onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))} t={t} /> )}{state.activeModal.type === 'rename-person' && state.activeModal.data && ( <RenamePersonModal initialName={state.people[state.activeModal.data.personId]?.name || ''} onConfirm={(newName: string) => handleRenamePerson(state.activeModal.data.personId, newName)} onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))} t={t} /> )}{state.activeModal.type === 'confirm-delete-tag' && state.activeModal.data && ( <ConfirmModal title={t('context.deleteTagConfirmTitle')} message={t('context.deleteTagConfirmMsg')} confirmText={t('context.deleteTagConfirmBtn')} confirmIcon={Trash2} onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))} onConfirm={() => { handleConfirmDeleteTags(state.activeModal.data.tags); setState(s => ({ ...s, activeModal: { type: null } })); }} t={t} /> )}{state.activeModal.type === 'confirm-delete-person' && state.activeModal.data && ( <ConfirmModal title={t('context.deletePersonConfirmTitle')} message={t('context.deletePersonConfirmMsg')} subMessage={typeof state.activeModal.data.personId === 'string' ? state.people[state.activeModal.data.personId]?.name : `${state.activeModal.data.personId.length}`} confirmText={t('settings.confirm')} confirmIcon={Trash2} onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))} onConfirm={() => { handleDeletePerson(state.activeModal.data.personId); setState(s => ({ ...s, activeModal: { type: null } })); }} t={t} /> )}{state.activeModal.type === 'edit-tags' && state.activeModal.data && ( <TagEditor file={state.files[state.activeModal.data.fileId]} files={state.files} onUpdate={handleUpdateFile} onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))} t={t} /> )}{(state.activeModal.type === 'copy-to-folder' || state.activeModal.type === 'move-to-folder') && ( <FolderPickerModal type={state.activeModal.type} files={state.files} roots={state.roots} selectedFileIds={state.activeModal.data?.fileIds || activeTab.selectedFileIds} onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))} onConfirm={(targetId: string) => { const fileIds = state.activeModal.data?.fileIds || activeTab.selectedFileIds; if (state.activeModal.type === 'copy-to-folder') handleCopyFiles(fileIds, targetId); else handleMoveFiles(fileIds, targetId); setState(s => ({ ...s, activeModal: { type: null } })); }} t={t} /> )}{state.activeModal.type === 'confirm-rename-file' && state.activeModal.data && ( <ConfirmModal title={t('settings.collisionTitle')} message={t('settings.fileCollisionMsg')} subMessage={`"${state.activeModal.data.desiredName}"`} confirmText={t('settings.renameAuto')} confirmIcon={FilePlus} onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))} onConfirm={() => { handleResolveFileCollision(state.activeModal.data.sourceId, state.activeModal.data.desiredName); setState(s => ({ ...s, activeModal: { type: null } })); }} t={t} /> )}{state.activeModal.type === 'confirm-merge-folder' && state.activeModal.data && ( <ConfirmModal title={t('settings.collisionTitle')} message={t('settings.folderCollisionMsg')} subMessage={t('settings.mergeDesc')} confirmText={t('settings.mergeFolder')} confirmIcon={Merge} onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))} onConfirm={() => { handleResolveFolderMerge(state.activeModal.data.sourceId, state.activeModal.data.targetId); setState(s => ({ ...s, activeModal: { type: null } })); }} t={t} /> )}{state.activeModal.type === 'confirm-extension-change' && state.activeModal.data && ( <ConfirmModal title={t('settings.extensionChangeTitle')} message={t('settings.extensionChangeMsg')} subMessage={t('settings.extensionChangeConfirm')} confirmText={t('settings.confirm')} confirmIcon={AlertTriangle} onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))} onConfirm={() => { handleResolveExtensionChange(state.activeModal.data.sourceId, state.activeModal.data.desiredName); setState(s => ({ ...s, activeModal: { type: null } })); }} t={t} /> )}{state.activeModal.type === 'confirm-overwrite-file' && state.activeModal.data && ( <ConfirmModal title={t('settings.collisionTitle')} message={state.activeModal.data.files.length === 1 ? t('settings.fileOverwriteMsg') : t('settings.filesOverwriteMsg').replace('%count%', state.activeModal.data.files.length.toString())} subMessage={state.activeModal.data.files.slice(0, 5).join(', ')+(state.activeModal.data.files.length > 5 ? `...` : '')} confirmText={t('settings.confirm')} confirmIcon={AlertTriangle} onClose={() => { state.activeModal.data.onCancel?.(); setState(s => ({ ...s, activeModal: { type: null } })); }} onConfirm={() => { state.activeModal.data.onConfirm?.(); setState(s => ({ ...s, activeModal: { type: null } })); }} t={t} /> )}
      {state.activeModal.type === 'crop-avatar' && state.activeModal.data && (
          <CropAvatarModal 
             fileUrl={state.activeModal.data.fileUrl}
             initialBox={state.activeModal.data.initialBox}
             personId={state.activeModal.data.personId}
             allFiles={state.files}
             people={state.people}
             onConfirm={(box: any) => handleSaveAvatarCrop(state.activeModal.data.personId, box)}
             onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))}
             t={t}
          />
      )}
      {state.activeModal.type === 'exit-confirm' && (
          <ExitConfirmModal 
              remember={rememberExitChoice} 
              onRememberChange={setRememberExitChoice}
              onConfirm={handleExitConfirm}
              t={t}
          />
      )}
      {state.activeModal.type === 'clear-person' && state.activeModal.data && (
          <ClearPersonModal 
              files={state.files}
              fileIds={state.activeModal.data.fileIds}
              people={state.people}
              onConfirm={(personIds: string[]) => {
                  handleClearPersonInfo(state.activeModal.data.fileIds, personIds);
                  setState(s => ({ ...s, activeModal: { type: null } }));
                  showToast(t('context.saved'));
              }}
              onClose={() => setState(s => ({ ...s, activeModal: { type: null } }))}
              t={t}
          />
      )}
      </div>)}
      
      {state.isSettingsOpen && ( <SettingsModal state={state} onClose={() => setState(s => ({ ...s, isSettingsOpen: false }))} onUpdateSettings={(updates) => {
          setState(s => ({ ...s, ...updates }));
      }} onUpdateSettingsData={(updates) => {
          setState(s => {
              const newSettings = { ...s.settings, ...updates };
              return { ...s, settings: newSettings };
          });
      }} onUpdatePath={handleChangePath} onUpdateAIConnectionStatus={(status) => setState(s => ({ ...s, aiConnectionStatus: status }))} t={t} /> )}
      
      {showCloseConfirmation && (
          <CloseConfirmationModal
              onClose={() => setShowCloseConfirmation(false)}
              onAction={handleCloseConfirmation}
              t={t}
          />
      )}
      
      <WelcomeModal 
        show={showWelcome} 
        onFinish={handleWelcomeFinish} 
        onSelectFolder={handleOpenFolder} 
        currentPath={state.roots.length > 0 ? state.files[state.roots[0]]?.path : ''} 
        settings={state.settings}
        onUpdateSettings={(updates: Partial<AppSettings>) => setState(s => ({ ...s, settings: { ...s.settings, ...updates } }))}
        t={t}
      />

      {contextMenu.visible && (
        <div data-testid="context-menu" className="fixed bg-white dark:bg-[#2d3748] border border-gray-200 dark:border-gray-700 rounded-md shadow-xl text-sm py-1 text-gray-800 dark:text-gray-200 min-w-[180px] z-[60] max-h-[80vh] overflow-y-auto" style={{ 
          top: 'auto', 
          bottom: 'auto', 
          left: 'auto', 
          right: 'auto',
          position: 'fixed',
          zIndex: 60
        }} ref={(el) => {
          if (el) {
            // 动态计算菜单位置，确保完全显示在屏幕内
            const rect = el.getBoundingClientRect();
            const menuWidth = rect.width;
            const menuHeight = rect.height;
            const screenWidth = window.innerWidth;
            const screenHeight = window.innerHeight;
            
            // 计算X位置，确保菜单不超出左右边界
            let x = contextMenu.x;
            if (x + menuWidth > screenWidth) {
              x = screenWidth - menuWidth;
            }
            if (x < 0) {
              x = 0;
            }
            
            // 计算Y位置，确保菜单不超出上下边界
            let y = contextMenu.y;
            if (y + menuHeight > screenHeight) {
              y = screenHeight - menuHeight;
            }
            if (y < 0) {
              y = 0;
            }
            
            // 设置最终位置
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
          }
        }}>
          {/* ... (Context Menu items, omitted for brevity but should be same as before) ... */}
          {/* 文件和文件夹的右键菜单（单个或多个） */}
          {(contextMenu.type === 'file-single' || contextMenu.type === 'file-multi' || contextMenu.type === 'folder-single' || contextMenu.type === 'folder-multi') && ( <>
                {/* ... Menu items ... */}
                {contextMenu.type !== 'file-multi' && (
                    <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleOpenInNewTab(contextMenu.targetId!); closeContextMenu(); }}>
                        <Layout size={14} className="mr-2 opacity-70"/> 
                        {contextMenu.type === 'folder-single' ? t('context.openFolderInNewTab') : t('context.openInNewTab')}
                    </div>
                )}
                
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleViewInExplorer(contextMenu.targetId!); closeContextMenu(); }}><ExternalLink size={14} className="mr-2 opacity-70"/> {t('context.viewInExplorer')}</div>
                {contextMenu.type === 'file-single' && state.files[contextMenu.targetId!] && ( (() => { const file = state.files[contextMenu.targetId!]; const parentId = file.parentId; const isUnavailable = activeTab.viewMode === 'browser' && activeTab.folderId === parentId; return ( <div className={`px-4 py-2 flex items-center ${isUnavailable ? 'text-gray-400 cursor-default' : 'hover:bg-blue-600 hover:text-white cursor-pointer'}`} onClick={() => { if (!isUnavailable && parentId) { enterFolder(parentId); closeContextMenu(); } }}>{t('context.openFolder')}</div> ); })() )}
                <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
                
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { setState(s => ({ ...s, activeModal: { type: 'copy-to-folder', data: { fileIds: activeTab.selectedFileIds.length > 0 ? activeTab.selectedFileIds : contextMenu.targetId ? [contextMenu.targetId] : [] } } })); closeContextMenu(); }}>{t('context.copyTo')}</div>
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { setState(s => ({ ...s, activeModal: { type: 'move-to-folder', data: { fileIds: activeTab.selectedFileIds.length > 0 ? activeTab.selectedFileIds : contextMenu.targetId ? [contextMenu.targetId] : [] } } })); closeContextMenu(); }}>{t('context.moveTo')}</div>
                {contextMenu.type === 'folder-single' && ( <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { navigator.clipboard.writeText(state.files[contextMenu.targetId!]?.path || ''); showToast(t('context.copied')); closeContextMenu(); }}>{t('context.copyFolderPath')}</div> )}
                <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
                {(contextMenu.type === 'file-single' || contextMenu.type === 'folder-single') && contextMenu.targetId && ( <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { startRename(contextMenu.targetId!); closeContextMenu(); }}>{t('context.rename')}</div> )}
                {contextMenu.type === 'folder-single' && contextMenu.targetId && state.aiConnectionStatus === 'connected' && (
                    <div className="px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center" onClick={() => {
                        handleFolderAIAnalysis(contextMenu.targetId!);
                        closeContextMenu();
                    }}>
                        <Sparkles size={14} className="mr-2 opacity-70"/> {t('context.aiAnalyze')}
                    </div>
                )}
                {contextMenu.type === 'file-single' && contextMenu.targetId && state.aiConnectionStatus === 'connected' && (
                    <div className="px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center" onClick={() => {
                        handleAIAnalysis([contextMenu.targetId!]);
                        closeContextMenu();
                    }}>
                        <Sparkles size={14} className="mr-2 opacity-70"/> {t('context.aiAnalyze')}
                    </div>
                )}
                {contextMenu.type === 'file-multi' && ( <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { setState(s => ({ ...s, activeModal: { type: 'batch-rename', data: null } })); closeContextMenu(); }}>{t('context.batchRename')}</div> )}
                {(contextMenu.type === 'file-multi') && state.aiConnectionStatus === 'connected' && (
                    <div className="px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center" onClick={() => {
                        handleAIAnalysis(activeTab.selectedFileIds);
                        closeContextMenu();
                    }}>
                        <Sparkles size={14} className="mr-2 opacity-70"/> {t('context.aiAnalyze')}
                    </div>
                )}
                {(contextMenu.type === 'file-single' || contextMenu.type === 'file-multi') && Object.keys(state.people).length > 0 && ( <> <div className="px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center" onClick={() => { setState(s => ({ ...s, activeModal: { type: 'add-to-person', data: null } })); closeContextMenu(); }}><User size={14} className="mr-2 opacity-70"/> {t('context.addToPerson')}</div><div className="px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center" onClick={() => { 
                    // Check how many unique people are in selected files
                    const fileIds = activeTab.selectedFileIds;
                    const allPeople = new Set<string>();
                    let totalFaces = 0;
                    
                    fileIds.forEach(fid => {
                        const file = state.files[fid];
                        if (file && file.type === FileType.IMAGE && file.aiData?.faces) {
                            file.aiData.faces.forEach(face => {
                                allPeople.add(face.personId);
                            });
                            totalFaces += file.aiData.faces.length;
                        }
                    });
                    
                    if (totalFaces === 0) {
                        // No faces to clear, just return
                        closeContextMenu();
                        return;
                    }
                    
                    if (allPeople.size <= 1) {
                        // Only one person or no person, just clear all
                        handleClearPersonInfo(fileIds);
                        closeContextMenu();
                        showToast(t('context.saved'));
                    } else {
                        // Multiple people, show modal to select which ones to clear
                        setState(s => ({ ...s, activeModal: { type: 'clear-person', data: { fileIds } } }));
                        closeContextMenu();
                    }
                }}><XCircle size={14} className="mr-2 opacity-70"/> {t('context.clearPersonInfo')}</div></> )}
                {(contextMenu.type === 'file-single' || contextMenu.type === 'file-multi') && ( <div className="px-4 py-2 hover:bg-pink-600 hover:text-white cursor-pointer flex items-center" onClick={() => { const targetIds = activeTab.selectedFileIds.length > 0 ? activeTab.selectedFileIds : (contextMenu.targetId ? [contextMenu.targetId] : []); setState(s => ({ ...s, activeModal: { type: 'add-to-topic', data: { fileIds: targetIds } } })); closeContextMenu(); }}><Layout size={14} className="mr-2 opacity-70"/> {t('context.addToTopic') || '添加到主题'}</div> )}
                {contextMenu.type === 'file-single' && contextMenu.targetId && ( <><div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { setState(s => ({ ...s, activeModal: { type: 'edit-tags', data: { fileId: contextMenu.targetId! } } })); closeContextMenu(); }}>{t('context.editTags')}</div><div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleCopyTags([contextMenu.targetId!]); closeContextMenu(); }}>{t('context.copyTag')}</div></> )}
                {/* 只有当所有选中的项目都是文件时才显示粘贴标签选项 */}
                {(() => {
                  // 检查所有选中的项目是否都是文件
                  const allAreFiles = activeTab.selectedFileIds.every(id => {
                    const file = state.files[id];
                    return file && file.type !== FileType.FOLDER;
                  });
                  return allAreFiles && ( <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handlePasteTags(activeTab.selectedFileIds); closeContextMenu(); }}>{t('context.pasteTag')}</div> );
                })()}

                {/* 只有文件夹类型才显示生成缩略图选项 */}
                {(contextMenu.type === 'folder-single' || contextMenu.type === 'folder-multi') && (
                    <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => {
                        const folderIds = contextMenu.type === 'folder-single' ? [contextMenu.targetId!] : activeTab.selectedFileIds;
                        handleGenerateThumbnails(folderIds);
                        closeContextMenu();
                    }}>
                        <ImageIcon size={14} className="mr-2 opacity-70"/> {t('context.generateThumbnails')}
                    </div>
                )}

                <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
                <div className="px-4 py-2 hover:bg-red-600 text-red-500 dark:text-red-400 hover:text-white cursor-pointer flex items-center" onClick={() => { requestDelete(activeTab.selectedFileIds); closeContextMenu(); }}><Trash2 size={14} className="mr-2"/> {t('context.delete')}</div>
          </> )}
          {contextMenu.type === 'root-folder' && contextMenu.targetId && ( <> <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleCreateFolder(contextMenu.targetId); closeContextMenu(); }}><FolderPlus size={14} className="mr-2 opacity-70"/> {t('context.createSubfolder')}</div><div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleExpandAll(contextMenu.targetId!); closeContextMenu(); }}><ChevronsDown size={14} className="mr-2 opacity-70"/> {t('context.expandAll')}</div><div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleCollapseAll(contextMenu.targetId!); closeContextMenu(); }}><ChevronsUp size={14} className="mr-2 opacity-70"/> {t('context.collapseAll')}</div> </> )}
          {(contextMenu.type === 'tag-single' || contextMenu.type === 'tag-multi') && contextMenu.targetId && ( <> 
            {contextMenu.type === 'tag-multi' ? (
                // Multiple tags selected: only show delete option
                <div className="px-4 py-2 hover:bg-red-600 text-red-500 dark:text-red-400 hover:text-white cursor-pointer flex items-center" onClick={() => {
                    requestDeleteTags(activeTab.selectedTagIds);
                    closeContextMenu();
                }}>
                    <Trash2 size={14} className="mr-2 opacity-70"/> {t('context.deleteTag')}
                </div>
            ) : (
                // Single tag selected: show full menu
                <> 
                    <div className="px-4 py-2 font-bold bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-600 mb-1">{contextMenu.targetId}</div>
                    <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { enterTagView(contextMenu.targetId!); closeContextMenu(); }}>{t('context.viewTagged')}</div>
                    <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { navigator.clipboard.writeText(contextMenu.targetId!); closeContextMenu(); }}>{t('context.copyName')}</div>
                    <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { setState(s => ({ ...s, activeModal: { type: 'rename-tag', data: { tag: contextMenu.targetId! } } })); closeContextMenu(); }}><Edit3 size={14} className="mr-2 opacity-70"/> {t('context.renameTag')}</div>
                    <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
                    <div className="px-4 py-2 hover:bg-red-600 text-red-500 dark:text-red-400 hover:text-white cursor-pointer" onClick={() => { requestDeleteTags(activeTab.selectedTagIds.length > 0 ? activeTab.selectedTagIds : [contextMenu.targetId!]); closeContextMenu(); }}>{t('context.deleteTag')}</div>
                </>
            )}
          </> )}
          {contextMenu.type === 'person' && ( <> 
            {activeTab.selectedPersonIds.length > 1 ? (
                <>
                <div className="px-4 py-2 hover:bg-pink-600 hover:text-white cursor-pointer flex items-center" onClick={() => { setState(s => ({ ...s, activeModal: { type: 'add-to-topic', data: { personIds: activeTab.selectedPersonIds } } })); closeContextMenu(); }}><Layout size={14} className="mr-2 opacity-70"/> {t('context.addToTopic') || '添加到主题'}</div>
                <div className="px-4 py-2 hover:bg-red-600 text-red-500 dark:text-red-400 hover:text-white cursor-pointer flex items-center" onClick={() => {
                    setState(s => ({ ...s, activeModal: { type: 'confirm-delete-person', data: { personId: activeTab.selectedPersonIds } } }));
                    closeContextMenu();
                }}>
                    <Trash2 size={14} className="mr-2 opacity-70"/> {t('context.delete')}
                </div>
                </>
            ) : contextMenu.targetId ? (
                // Single person selected: show full menu
                <> 
                    <div className="px-4 py-2 font-bold bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-600 mb-1">{state.people[contextMenu.targetId]?.name}</div>
                    <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { enterPersonView(contextMenu.targetId!); closeContextMenu(); }}>{t('context.viewTagged')}</div>
                    <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleSetAvatar(contextMenu.targetId!); closeContextMenu(); }}><Crop size={14} className="mr-2 opacity-70"/> {t('context.setAvatar')}</div>
                    <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { setState(s => ({ ...s, activeModal: { type: 'rename-person', data: { personId: contextMenu.targetId! } } })); closeContextMenu(); }}><Edit3 size={14} className="mr-2 opacity-70"/> {t('context.renamePerson')}</div><div className="px-4 py-2 hover:bg-pink-600 hover:text-white cursor-pointer flex items-center" onClick={() => { setState(s => ({ ...s, activeModal: { type: 'add-to-topic', data: { personIds: [contextMenu.targetId!] } } })); closeContextMenu(); }}><Layout size={14} className="mr-2 opacity-70"/> {t('context.addToTopic') || '添加到主题'}</div>
                    <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
                    <div className="px-4 py-2 hover:bg-red-600 text-red-500 dark:text-red-400 hover:text-white cursor-pointer flex items-center" onClick={() => {
                        setState(s => ({ ...s, activeModal: { type: 'confirm-delete-person', data: { personId: contextMenu.targetId! } } }));
                        closeContextMenu();
                    }}>
                        <Trash2 size={14} className="mr-2 opacity-70"/> {t('context.deletePerson')}
                    </div> 
                </>
            ) : null}
          </> )}
          {contextMenu.type === 'tab' && contextMenu.targetId && ( <> <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={(e) => { handleCloseTab(e, contextMenu.targetId!); closeContextMenu(); }}>{t('context.closeTab')}</div><div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleCloseOtherTabs(contextMenu.targetId!); closeContextMenu(); }}>{t('context.closeOtherTabs')}</div><div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleCloseAllTabs(); closeContextMenu(); }}>{t('context.closeAllTabs')}</div> </> )}
          {contextMenu.type === 'background' && ( <> 
            {/* 根据当前视图模式显示不同的菜单选项 */}
            {activeTab.viewMode === 'people-overview' ? (
              // 人物主界面：显示新建人物选项
              <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleCreatePerson(); closeContextMenu(); }}>{t('context.newPerson')}</div>
            ) : (
              // 其他界面：显示原有选项
              <> 
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleRefresh(); closeContextMenu(); }}>{t('context.refresh')}</div>
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { 
                  // 全选当前目录下的所有内容
                  updateActiveTab({ selectedFileIds: displayFileIds });
                  closeContextMenu(); 
                }}>{t('context.selectAll')}</div>
                <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleCreateFolder(); closeContextMenu(); }}>{t('context.newFolder')}</div>
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleCreateNewTag(); closeContextMenu(); }}>{t('context.newTag')}</div>
              </>
            )}
          </> )}
          {contextMenu.type === 'tag-background' && ( <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleCreateNewTag(); closeContextMenu(); }}>{t('context.newTag')}</div> )}
        </div>
      )}
    </div>
  );
};

export default App;
